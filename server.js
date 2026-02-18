const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const WebSocket = require("ws");
const { WebSocketServer } = require("ws");

console.log("📦 Starting server...");
console.log(`Node version: ${process.version}`);

// Global error handlers
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});

const app = express();

// Twilio sends application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ========================
// Config
// ========================
const PORT = process.env.PORT || 3000;
let BASE_URL =
  process.env.BASE_URL || `http://localhost:${PORT}`;
// Sanitize BASE_URL: remove trailing slashes and path segments
try {
  const url = new URL(BASE_URL);
  BASE_URL = url.origin; // Extract just protocol + hostname + port
} catch (err) {
  // If URL parsing fails, remove trailing slash and any path segments
  BASE_URL = BASE_URL.replace(/\/[^\/]*$/, "").replace(/\/+$/, "");
}
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  "https://okgbvaeaqrcuxlzgwgjc.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9rZ2J2YWVhcXJjdXhsemd3Z2pjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk1NjMwMTMsImV4cCI6MjA4NTEzOTAxM30.BPsHornv7HW_RX7Ys7FBaeCygnN9BV7FwLWmMjaUQLU";

// Check OpenAI API key
if (!OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY not set. OpenAI features will not work.");
} else {
  console.log("✅ OpenAI API key configured");
}

// Initialize Supabase
const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

if (supabase) {
  console.log("✅ Supabase configured");
} else {
  console.warn("⚠️ Supabase not configured");
}

// ========================
// WebSocket Server for Media Streams
// ========================
const wss = new WebSocketServer({ noServer: true });

// Store active connections: Map<streamSid, { twilioWs, openaiWs, conversation }>
const activeConnections = new Map();

// Cleanup stale connections every 5 minutes
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [streamSid, conn] of activeConnections.entries()) {
    if (conn.connectedAt && now - conn.connectedAt > 15 * 60 * 1000) {
      console.log(`🧹 Cleaning up stale connection: ${streamSid}`);
      if (conn.openaiWs) conn.openaiWs.close();
      if (conn.twilioWs) conn.twilioWs.close();
      activeConnections.delete(streamSid);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} stale connection(s)`);
  }
}, 5 * 60 * 1000);

// ========================
// Health & Root
// ========================
app.get("/", (req, res) => {
  res.status(200).send("ok");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// ========================
// Twilio Voice Webhook
// ========================
app.post("/voice", async (req, res) => {
  console.log("📞 Incoming call");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.get("host")}/media-stream" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ========================
// Error Handling Middleware
// ========================
app.use((err, req, res, next) => {
  console.error("❌ Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// 404 handler
app.use((req, res) => {
  console.log(`⚠️ 404: ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found" });
});

// ========================
// Handle save_service_call function call from OpenAI
// ========================
async function handleSaveServiceCall(args, callerPhone) {
  if (!supabase) {
    console.error("❌ Supabase not configured");
    return;
  }

  try {
    console.log("💾 Processing service call save:", args);

    const isLead =
      args.call_type === "quote" || args.call_type === "general_inquiry";

    if (!isLead) {
      // SERVICE CALL / EMERGENCY / MAINTENANCE / CALLBACK → save customer + work order

      // Check if customer exists by phone number
      let customerId = null;
      if (callerPhone) {
        const { data: existingCustomers, error: searchError } =
          await supabase
            .from("customers")
            .select("id")
            .eq("phone_number", callerPhone)
            .limit(1);

        if (searchError) {
          console.error("Error searching for customer:", searchError);
        }

        if (existingCustomers && existingCustomers.length > 0) {
          customerId = existingCustomers[0].id;
          console.log("✅ Found existing customer:", customerId);
        }
      }

      // Create or update customer
      if (!customerId) {
        const customerData = {
          customer_name: args.customer_name,
          phone_number: callerPhone,
          primary_address: args.service_address,
          customer_type: args.property_type === "commercial" ? "Commercial" : "Residential",
          source: args.referral_source || "Phone Call",
        };
        if (args.email) customerData.email = args.email;

        console.log("About to insert customer with data:", customerData);
        const { data: newCustomer, error: customerError } = await supabase
          .from("customers")
          .insert([customerData])
          .select();

        if (customerError) {
          console.error("❌ Error creating customer:", customerError);
          return;
        }

        customerId = newCustomer[0].id;
        console.log("✅ Created new customer:", customerId);
      }

      // Create work order with rich data
      const workOrderData = {
        customer_id: customerId,
        service_address: args.service_address,
        issue_description: args.issue_description,
        system_type: args.system_type || "unknown",
        priority: args.priority
          ? args.priority.charAt(0).toUpperCase() + args.priority.slice(1)
          : "Standard",
        status: "New",
        call_type: args.call_type,
      };
      if (args.system_brand) workOrderData.system_brand = args.system_brand;
      if (args.system_age_years) workOrderData.system_age_years = args.system_age_years;
      if (args.access_instructions) workOrderData.access_instructions = args.access_instructions;
      if (args.scheduling_preference) workOrderData.scheduling_preference = args.scheduling_preference;
      if (args.onsite_contact) workOrderData.onsite_contact = args.onsite_contact;
      if (args.additional_notes) workOrderData.additional_notes = args.additional_notes;

      const { data: workOrder, error: workOrderError } = await supabase
        .from("work_orders")
        .insert([workOrderData])
        .select();

      if (workOrderError) {
        console.error("❌ Error creating work order:", workOrderError);
        return;
      }

      console.log("✅ Created work order:", workOrder[0].id);
    } else {
      // QUOTE / GENERAL INQUIRY → save as lead
      const leadData = {
        lead_name: args.customer_name || "Unknown",
        phone_number: callerPhone,
        notes: args.issue_description || "General inquiry",
        status: "New",
        inquiry_type: args.call_type === "quote" ? "Quote Request" : "General Question",
      };
      if (args.email) leadData.email = args.email;
      if (args.property_type) leadData.property_type = args.property_type;
      if (args.service_address) leadData.service_address = args.service_address;
      if (args.referral_source) leadData.referral_source = args.referral_source;
      if (args.system_brand) leadData.current_system_brand = args.system_brand;
      if (args.system_age_years) leadData.current_system_age = args.system_age_years;
      if (args.scheduling_preference) leadData.consultation_preferred_time = args.scheduling_preference;

      const { data: lead, error: leadError } = await supabase
        .from("leads")
        .insert([leadData])
        .select();

      if (leadError) {
        console.error("❌ Error creating lead:", leadError);
        return;
      }

      console.log("✅ Created lead:", lead[0].id);
    }

    console.log("💾 Successfully saved to Supabase");
  } catch (err) {
    console.error("❌ Error saving to Supabase:", err);
    throw err;
  }
}

// ========================
// Connect to OpenAI Realtime API
// ========================
async function connectToOpenAI(streamSid, conversationData) {
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  return new Promise((resolve, reject) => {
    openaiWs.on("open", () => {
      console.log("🤖 Connected to OpenAI Realtime API");

      // Configure session
      const sessionUpdate = {
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          instructions: `You are AVA, the virtual assistant for an HVAC service company.

PERSONALITY:
- Warm, confident, and efficient — like the best office manager you've ever met
- You're genuinely helpful, not performatively helpful
- You use casual-professional language — friendly but competent
- You speak in short, clear sentences — never long-winded
- You adapt your energy to the caller — calm for emergencies, upbeat for tune-ups
- You NEVER sound like a robot reading a script

CRITICAL BEHAVIOR RULES:
1. ALWAYS let the caller finish speaking before responding. Wait for a full pause.
2. NEVER ask for their phone number — you already have it from caller ID.
3. If they give you information you didn't ask for yet, acknowledge it and skip that question.
4. If they seem confused or unsure, offer options rather than open-ended questions.
5. NEVER quote specific pricing unless explicitly authorized.
6. For gas leaks, carbon monoxide, electrical sparking, or flooding: immediately advise calling 911 if dangerous, then proceed with emergency dispatch.
7. Keep the total call under 3-4 minutes for standard service, under 2 minutes for emergencies.
8. When confirming details, summarize naturally — don't parrot back every word.
9. Always end with a clear "what happens next" and a specific timeframe.
10. If the caller wants a human, don't resist — capture their info and promise a callback.

CONVERSATION STRUCTURE:
Phase 1 — Greeting + Classification (0-15 seconds)
  Greet warmly, ask how you can help, listen to classify the call type.

Phase 2 — Empathy + Engagement (15-30 seconds)
  Acknowledge their situation before asking for data. Match their energy.
  - Emergency: "Let's get someone to you right away"
  - Service: "That's no fun, let's get that taken care of"
  - Maintenance: "Smart move getting ahead of it"
  - Quote: "Absolutely, we can help with that"

Phase 3 — Data Collection (30 seconds - 2.5 minutes)
  Collect required fields for this call type. Ask one question at a time.
  Use natural transitions between questions. Accept partial info gracefully.

Phase 4 — Confirmation + Next Steps (15-30 seconds)
  Brief natural summary of what you captured. Clear next step with timeframe.
  Reassurance. Friendly close.

CALL TYPES AND WHAT TO COLLECT:
1. EMERGENCY (gas smell, no heat in winter, CO alarm, flooding, sparking):
   - Issue safety warning if needed ("If you smell gas strongly, step outside and call 911")
   - Name, address, brief description, access instructions — that's it, move fast
   - "A technician will call you back within 30 minutes"

2. SERVICE REQUEST (AC not cooling, heater won't turn on, making noises):
   - Name, address, home or business?, issue description, when it started, what they've tried
   - System details if offered (brand, age — "totally fine if you don't know")
   - Access instructions, scheduling preference, who will be on-site, referral source
   - "A technician will reach out within 2 hours"

3. MAINTENANCE/TUNE-UP (annual service, tune-up, inspection):
   - Name, address, home or business?, which system (heating/cooling/both)
   - System details, scheduling preference, access, referral source
   - Upsell naturally: "just the furnace, or want us to look at the AC too?"

4. QUOTE/ESTIMATE (pricing, replacement, thinking about new system):
   - Name, address, home or business?, what they're looking for
   - Current system details, interest areas (efficiency, heat pump, etc.)
   - Push toward in-home consultation — never quote pricing on phone
   - Scheduling preference, email for confirmation, referral source

5. EXISTING CUSTOMER/CALLBACK (someone was just here, calling back about):
   - Verify name, confirm address on file, capture new/recurring issue
   - Flag as callback/return visit for priority

DATA TO COLLECT (in priority order):
1. Full name
2. Service address (confirm: "Is that a house or a business?")
3. Issue description (let them explain, then ask clarifying questions)
4. System details if relevant (type, brand, age — make these optional/low-pressure)
5. Access instructions (gate codes, locked areas, pets)
6. Scheduling preference
7. Who will be on-site
8. Referral source ("How'd you hear about us?")
9. Email (optional — only for quotes/estimates)

URGENCY DETECTION:
- EMERGENCY: gas smell, no heat (winter), CO alarm, flooding, electrical issues, sparking
- URGENT: system not working at all, home is very hot/cold, elderly or infant in home
- STANDARD: system working but poorly, intermittent issues, noises
- LOW: maintenance, tune-ups, inspections, general questions

NATURAL LANGUAGE:
Use: "Let's get that taken care of", "I hear you", "Here's what's going to happen", "You're in good hands", "Smart move", "That's helpful, thank you", "Totally fine if you don't know", "You won't need to repeat yourself"
Never use: "I understand your frustration", "For quality assurance purposes", "Your call is important to us", "Let me repeat that back to you", "Per our records"
Transitions: "And—", "Now—", "One more thing—", "Last thing—", "Great. So—", "That helps. Now—"

WHEN YOU HAVE ALL REQUIRED INFO:
Call the save_service_call function with all collected data. Then confirm to the caller what happens next.

WHEN YOU DON'T KNOW SOMETHING:
If they ask about pricing, availability, or warranty: "That's a great question. I want to make sure you get an accurate answer, so I'll have the team include that when they reach out to you."`,
          voice: "alloy",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: {
            type: "server_vad",
            threshold: 0.7, // Much higher - only trigger on clear speech
            prefix_padding_ms: 800, // Capture more of beginning
            silence_duration_ms: 2500, // Wait 2.5 FULL SECONDS before assuming done
          },
          input_audio_transcription: {
            model: "whisper-1",
          },
          tools: [
            {
              type: "function",
              name: "save_service_call",
              description:
                "Save a completed service call to the database. Call this when you have collected all necessary information from the caller.",
              parameters: {
                type: "object",
                properties: {
                  call_type: {
                    type: "string",
                    enum: [
                      "emergency",
                      "service_request",
                      "maintenance",
                      "quote",
                      "callback",
                      "general_inquiry",
                    ],
                    description:
                      "The type of call based on what the customer needs",
                  },
                  customer_name: {
                    type: "string",
                    description: "Full name of the caller",
                  },
                  service_address: {
                    type: "string",
                    description:
                      "Full street address where service is needed",
                  },
                  property_type: {
                    type: "string",
                    enum: ["residential", "commercial"],
                    description:
                      "Whether the property is a home or business",
                  },
                  issue_description: {
                    type: "string",
                    description:
                      "Natural language summary of what the customer described as the problem, including symptoms, duration, and any diagnostic details",
                  },
                  system_type: {
                    type: "string",
                    enum: ["heating", "cooling", "both", "unknown"],
                    description: "Which HVAC system is affected",
                  },
                  system_brand: {
                    type: "string",
                    description:
                      "Brand of the HVAC system if mentioned",
                  },
                  system_age_years: {
                    type: "number",
                    description:
                      "Approximate age of the system in years if mentioned",
                  },
                  priority: {
                    type: "string",
                    enum: ["emergency", "urgent", "standard", "low"],
                    description: "Urgency level based on the issue",
                  },
                  access_instructions: {
                    type: "string",
                    description:
                      "Gate codes, locked areas, pet warnings, or other access notes",
                  },
                  scheduling_preference: {
                    type: "string",
                    description:
                      "When the customer prefers service (e.g., 'ASAP', 'Tuesday morning', 'Saturday afternoon')",
                  },
                  onsite_contact: {
                    type: "string",
                    description:
                      "Who will be present for the service visit",
                  },
                  referral_source: {
                    type: "string",
                    description:
                      "How the customer heard about the company",
                  },
                  email: {
                    type: "string",
                    description: "Customer email if provided",
                  },
                  additional_notes: {
                    type: "string",
                    description:
                      "Any other relevant details — what they've already tried, previous tech visits, special requests",
                  },
                },
                required: [
                  "call_type",
                  "customer_name",
                  "service_address",
                  "issue_description",
                  "priority",
                ],
              },
            },
          ],
          tool_choice: "auto",
          temperature: 0.7,
          max_response_output_tokens: 300,
        },
      };

      openaiWs.send(JSON.stringify(sessionUpdate));

      // Send initial greeting — AVA introduces herself naturally
      openaiWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions:
              "Greet the caller warmly and naturally. Say something like: \"Hi, this is AVA — how can I help you today?\" Keep it short and warm. Then listen to classify their call type.",
          },
        })
      );

      resolve(openaiWs);
    });

    openaiWs.on("error", (error) => {
      console.error("❌ OpenAI WebSocket error:", error);
      reject(error);
    });

    openaiWs.on("message", async (data) => {
      try {
        const event = JSON.parse(data);

        // Log important events
        if (
          event.type === "response.audio.delta" ||
          event.type === "input_audio_buffer.speech_started"
        ) {
          // Skip logging these (too verbose)
        } else {
          console.log(`🤖 OpenAI event: ${event.type}`);
        }

        // Get connection once for reuse
        const connection = activeConnections.get(streamSid);

        // Handle different event types
        switch (event.type) {
          case "session.created":
          case "session.updated":
            console.log("✅ Session configured");
            break;

          case "response.audio.delta":
            // Send audio back to Twilio
            if (
              connection &&
              connection.twilioWs.readyState === WebSocket.OPEN
            ) {
              const audioMessage = {
                event: "media",
                streamSid: streamSid,
                media: {
                  payload: event.delta,
                },
              };
              connection.twilioWs.send(JSON.stringify(audioMessage));
            }
            break;

          case "response.audio_transcript.done":
            console.log(`🤖 AVA said: ${event.transcript}`);
            break;

          case "conversation.item.input_audio_transcription.completed":
            console.log(`🗣️ Caller said: ${event.transcript}`);
            break;

          case "response.function_call_arguments.done":
            // OpenAI is calling our save_service_call function
            console.log(
              `🔧 Function call: ${event.name}`,
              event.arguments
            );

            if (event.name === "save_service_call") {
              try {
                const args = JSON.parse(event.arguments);
                console.log("💾 Saving service call data:", args);

                // Save to Supabase using the structured data from AI
                await handleSaveServiceCall(
                  args,
                  connection?.conversationData?.phone
                );

                // Send function result back to OpenAI so it can confirm to caller
                openaiWs.send(
                  JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({
                        success: true,
                        message:
                          "Service call saved successfully. Confirm the details to the caller and let them know what happens next.",
                      }),
                    },
                  })
                );

                // Trigger OpenAI to respond with confirmation
                openaiWs.send(
                  JSON.stringify({ type: "response.create" })
                );
              } catch (err) {
                console.error(
                  "❌ Error handling function call:",
                  err
                );

                // Send error result back to OpenAI
                openaiWs.send(
                  JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                      type: "function_call_output",
                      call_id: event.call_id,
                      output: JSON.stringify({
                        success: false,
                        message:
                          "There was an issue saving, but reassure the caller their information has been noted and a technician will follow up.",
                      }),
                    },
                  })
                );

                openaiWs.send(
                  JSON.stringify({ type: "response.create" })
                );
              }
            }
            break;

          case "response.done":
            console.log("✅ Response completed");
            break;

          case "error":
            console.error("❌ OpenAI error:", event.error);
            break;
        }
      } catch (err) {
        console.error("❌ Error parsing OpenAI message:", err);
      }
    });

    openaiWs.on("close", () => {
      console.log("🤖 OpenAI WebSocket closed");
    });
  });
}

// ========================
// WebSocket Connection Handler
// ========================
wss.on("connection", async (twilioWs) => {
  console.log("📡 Twilio WebSocket connected");

  let streamSid = null;
  let openaiWs = null;
  let conversationData = {
    phone: null,
  };

  // Handle messages from Twilio
  twilioWs.on("message", async (message) => {
    try {
      const msg = JSON.parse(message);

      switch (msg.event) {
        case "start":
          streamSid = msg.start.streamSid;
          console.log(`📞 Stream started: ${streamSid}`);

          // Store caller phone
          conversationData.phone =
            msg.start.customParameters?.From || msg.start.callSid;

          // Connect to OpenAI Realtime API
          openaiWs = await connectToOpenAI(streamSid, conversationData);

          // Store connection
          activeConnections.set(streamSid, {
            twilioWs,
            openaiWs,
            conversationData,
            connectedAt: Date.now(),
          });
          break;

        case "media":
          // Forward audio to OpenAI
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            const audioAppend = {
              type: "input_audio_buffer.append",
              audio: msg.media.payload,
            };
            openaiWs.send(JSON.stringify(audioAppend));
          }
          break;

        case "stop":
          console.log(`📞 Stream stopped: ${streamSid}`);
          if (openaiWs) {
            openaiWs.close();
          }
          activeConnections.delete(streamSid);
          break;
      }
    } catch (err) {
      console.error("❌ Error handling Twilio message:", err);
    }
  });

  twilioWs.on("close", () => {
    console.log("📡 Twilio WebSocket closed");
    if (openaiWs) {
      openaiWs.close();
    }
    if (streamSid) {
      activeConnections.delete(streamSid);
    }
  });
});

// ========================
// HTTP Server Upgrade for WebSockets
// ========================
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health check: http://0.0.0.0:${PORT}/health`);
  if (supabase) {
    console.log(`✅ Supabase configured`);
  }
}).on("error", (err) => {
  console.error("❌ Failed to start server:", err);
  process.exit(1);
});

// Handle WebSocket upgrades
server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(
    request.url,
    `http://${request.headers.host}`
  ).pathname;

  if (pathname === "/media-stream") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Server is started in HTTP upgrade handler above
