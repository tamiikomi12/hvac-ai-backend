const express = require("express");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");
const WebSocket = require("ws");
const { WebSocketServer } = require("ws");

// Conversation states
const CONVERSATION_STATES = {
  GREETING: "GREETING",
  DETERMINE_CALL_TYPE: "DETERMINE_CALL_TYPE",
  GET_NAME: "GET_NAME",
  GET_PHONE: "GET_PHONE",
  GET_ADDRESS: "GET_ADDRESS",
  GET_ISSUE: "GET_ISSUE",
  CONFIRM: "CONFIRM",
  COMPLETE: "COMPLETE",
  LEAD_INQUIRY: "LEAD_INQUIRY",
};

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
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  "https://okgbvaeaqrcuxlzgwgjc.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9rZ2J2YWVhcXJjdXhsemd3Z2pjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk1NjMwMTMsImV4cCI6MjA4NTEzOTAxM30.BPsHornv7HW_RX7Ys7FBaeCygnN9BV7FwLWmMjaUQLU";

// Initialize OpenAI client
if (!OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY not set. OpenAI features will not work.");
}
const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

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

// ========================
// Conversation Store
// ========================
// In-memory store: { CallSid: { history: [...], lastActive: timestamp, state: '...', collectedData: {...} } }
const conversations = new Map();

// Helper: Escape XML special characters for TwiML
function escapeXml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Helper: Cleanup old conversations (inactive > 15 minutes)
function cleanupOldConversations() {
  const now = Date.now();
  const fifteenMinutes = 15 * 60 * 1000;
  let cleaned = 0;

  for (const [callSid, conv] of conversations.entries()) {
    if (now - conv.lastActive > fifteenMinutes) {
      conversations.delete(callSid);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} old conversation(s)`);
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupOldConversations, 5 * 60 * 1000);

// Helper: Determine priority from issue description
function determinePriority(issueDescription) {
  const issue = issueDescription.toLowerCase();

  // Emergency keywords
  if (
    issue.includes("not working") ||
    issue.includes("no heat") ||
    issue.includes("no ac") ||
    issue.includes("no air") ||
    issue.includes("freezing") ||
    issue.includes("too hot") ||
    issue.includes("emergency")
  ) {
    return "Emergency";
  }

  // Urgent keywords
  if (
    issue.includes("strange noise") ||
    issue.includes("smell") ||
    issue.includes("leaking") ||
    issue.includes("leak") ||
    issue.includes("loud")
  ) {
    return "Urgent";
  }

  // Default to standard
  return "Standard";
}

// Helper: Determine system type from issue description
function determineSystemType(issueDescription) {
  const issue = issueDescription.toLowerCase();

  if (
    issue.includes("heat") ||
    issue.includes("furnace") ||
    issue.includes("warm")
  ) {
    return "Heating";
  }

  if (
    issue.includes("ac") ||
    issue.includes("air conditioning") ||
    issue.includes("cooling") ||
    issue.includes("cold")
  ) {
    return "Cooling";
  }

  return "Unknown";
}

// Helper: Extract data from user responses using OpenAI
async function extractDataFromResponse(userMessage, fieldToExtract) {
  if (!openai) return null;

  const prompts = {
    name: "Extract just the person's name from this message. Return only the name, nothing else: ",
    phone: "Extract the phone number from this message. Return only the phone number in format XXX-XXX-XXXX if possible, otherwise as given: ",
    address:
      "Extract the full service address from this message. Return only the address: ",
    callType:
      'Is this person calling to schedule HVAC service (return "work_order") or just asking for information/pricing (return "lead")? Return only work_order or lead: ',
  };

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "user",
          content: prompts[fieldToExtract] + userMessage,
        },
      ],
      temperature: 0.3,
      max_tokens: 50,
    });

    const extracted = completion.choices[0]?.message?.content?.trim();
    return extracted || null;
  } catch (err) {
    console.error("Error extracting data:", err);
    return null;
  }
}

// Helper: Get prompt for current state
function getPromptForState(state, collectedData) {
  switch (state) {
    case CONVERSATION_STATES.GREETING:
      return 'You are AVA, a receptionist for an HVAC company. Say: "Hi, this is AVA. Are you calling to schedule HVAC service, or do you have questions about our services?" Say ONLY this. Do not add anything else.';

    case CONVERSATION_STATES.GET_NAME:
      return 'You are AVA, a receptionist. Say: "Great! Can I get your name please?" Say ONLY this. Do not add anything else.';

    case CONVERSATION_STATES.GET_ADDRESS:
      return `You are AVA, a receptionist. Say: "Thanks ${collectedData.name}. What's the address where you need service?" Say ONLY this. Do not add anything else.`;

    case CONVERSATION_STATES.GET_ISSUE:
      return `You are AVA, a receptionist. Say: "Got it. Can you briefly describe what's happening with your HVAC system?" Say ONLY this. Do not provide ANY troubleshooting advice. Do not list steps. Just ask the question.`;

    case CONVERSATION_STATES.CONFIRM:
      return `You are AVA, a receptionist. Say EXACTLY: "I've created a service request for ${collectedData.issue} at ${collectedData.address}. A technician will call you back within 2 hours. Is there anything else I should note?" Do NOT provide troubleshooting steps. Do NOT give advice. ONLY say this confirmation.`;

    case CONVERSATION_STATES.LEAD_INQUIRY:
      return 'You are AVA, a receptionist. Answer their question briefly in 1-2 sentences, then ask: "Can I get your name and number for follow-up?" Keep it very brief.';

    default:
      return "You are AVA, a receptionist for HVAC services. Be brief and professional. Do not provide troubleshooting advice.";
  }
}

// Helper: Save collected data to Supabase
async function saveToSupabase(collectedData, callerPhoneNumber) {
  if (!supabase) {
    console.error("❌ Supabase not configured");
    return;
  }

  try {
    console.log("💾 Saving to Supabase:", collectedData);

    if (collectedData.callType === "work_order") {
      // Check if customer exists by phone number
      const { data: existingCustomers, error: searchError } = await supabase
        .from("customers")
        .select("id")
        .eq("phone_number", collectedData.phone)
        .limit(1);

      if (searchError) {
        console.error("Error searching for customer:", searchError);
      }

      let customerId = null;

      if (existingCustomers && existingCustomers.length > 0) {
        customerId = existingCustomers[0].id;
        console.log("✅ Found existing customer:", customerId);
      } else {
        // Create new customer
        console.log("About to insert customer with data:", {
          customer_name: collectedData.name,
          phone_number: collectedData.phone,
          primary_address: collectedData.address,
          customer_type: "Residential",
          source: "Direct Work Order",
        });
        const { data: newCustomer, error: customerError } = await supabase
          .from("customers")
          .insert([
            {
              customer_name: collectedData.name,
              phone_number: collectedData.phone,
              primary_address: collectedData.address,
              customer_type: "Residential",
              source: "Direct Work Order",
            },
          ])
          .select();

        if (customerError) {
          console.error("❌ Error creating customer:", customerError);
          return;
        }

        customerId = newCustomer[0].id;
        console.log("✅ Created new customer:", customerId);
      }

      // Create work order
      const { data: workOrder, error: workOrderError } = await supabase
        .from("work_orders")
        .insert([
          {
            customer_id: customerId,
            service_address: collectedData.address,
            issue_description: collectedData.issue,
            system_type: collectedData.systemType,
            priority: collectedData.priority,
            status: "New",
          },
        ])
        .select();

      if (workOrderError) {
        console.error("❌ Error creating work order:", workOrderError);
        return;
      }

      console.log("✅ Created work order:", workOrder[0].id);
    } else if (collectedData.callType === "lead") {
      // Save as lead
      const { data: lead, error: leadError } = await supabase
        .from("leads")
        .insert([
          {
            lead_name: collectedData.name || "Unknown",
            phone_number: collectedData.phone || callerPhoneNumber,
            notes: collectedData.issue || "General inquiry",
            status: "New",
            inquiry_type: "General Question",
          },
        ])
        .select();

      if (leadError) {
        console.error("❌ Error creating lead:", leadError);
        return;
      }

      console.log("✅ Created lead:", lead[0].id);
    }
  } catch (err) {
    console.error("❌ Error saving to Supabase:", err);
  }
}

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
// Helper: Extract data from conversation
// ========================
function extractDataFromTranscript(transcript, conversationData) {
  const lower = transcript.toLowerCase();

  // Detect call type
  if (!conversationData.callType) {
    if (
      lower.includes("schedule") ||
      lower.includes("service") ||
      lower.includes("repair") ||
      lower.includes("fix") ||
      lower.includes("broken") ||
      lower.includes("not working")
    ) {
      conversationData.callType = "work_order";
      console.log("🎯 Detected: work_order");
    } else if (
      lower.includes("question") ||
      lower.includes("price") ||
      lower.includes("cost") ||
      lower.includes("info")
    ) {
      conversationData.callType = "lead";
      console.log("🎯 Detected: lead");
    }
  }

  // Simple name extraction (anything that sounds like a name after "my name is" or similar)
  if (!conversationData.name && conversationData.callType === "work_order") {
    const namePatterns = [
      /(?:my name is|i'm|this is|name's)\s+([a-z]+(?:\s+[a-z]+)?)/i,
      /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)$/,
    ];

    for (const pattern of namePatterns) {
      const match = transcript.match(pattern);
      if (match && match[1] && match[1].length > 2) {
        conversationData.name = match[1].trim();
        console.log(`🎯 Extracted name: ${conversationData.name}`);
        break;
      }
    }
  }

  // Address extraction (look for street numbers and common address words)
  if (
    !conversationData.address &&
    conversationData.callType === "work_order"
  ) {
    if (
      /\d+.*(?:street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|lane|ln|way|court|ct)/i.test(
        lower
      )
    ) {
      conversationData.address = transcript.trim();
      console.log(`🎯 Extracted address: ${conversationData.address}`);
    }
  }

  // Issue extraction (if they mention HVAC problems)
  if (!conversationData.issue && conversationData.callType === "work_order") {
    if (
      lower.includes("ac") ||
      lower.includes("air") ||
      lower.includes("heat") ||
      lower.includes("furnace") ||
      lower.includes("cool") ||
      lower.includes("warm") ||
      lower.includes("not working") ||
      lower.includes("broken")
    ) {
      conversationData.issue = transcript.trim();
      conversationData.systemType = determineSystemType(transcript);
      conversationData.priority = determinePriority(transcript);
      console.log(`🎯 Extracted issue: ${conversationData.issue}`);
      console.log(
        `🎯 System: ${conversationData.systemType}, Priority: ${conversationData.priority}`
      );
    }
  }
}

// ========================
// Save complete conversation to Supabase
// ========================
async function saveConversationToSupabase(conversationData) {
  // Check if we have minimum required data
  if (conversationData.callType === "work_order") {
    if (
      !conversationData.name ||
      !conversationData.address ||
      !conversationData.issue
    ) {
      console.log("⚠️ Incomplete work order data, not saving yet");
      return;
    }
  }

  try {
    await saveToSupabase(conversationData, conversationData.phone);
    console.log("💾 Successfully saved to Supabase");
  } catch (err) {
    console.error("❌ Failed to save to Supabase:", err);
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
          instructions: `You are AVA, a professional receptionist for an HVAC company. Your job is to collect information from callers who need HVAC service.

CONVERSATION FLOW:
1. First, determine if they're calling to schedule service or just asking questions
2. If scheduling service, collect in this order:
   - Their name
   - Service address 
   - Description of the HVAC issue
3. Confirm the information and tell them a technician will call back within 2 hours
4. Be friendly, professional, and brief - keep responses to 1-2 sentences
5. Do NOT provide troubleshooting advice or solutions
6. Do NOT list steps they can try
7. Just collect information and confirm

CRITICAL RULES:
- Never provide technical advice
- Never troubleshoot issues
- Just collect data and reassure them help is coming
- Keep responses SHORT - you're on a phone call, not writing an essay`,
          voice: "alloy",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
          input_audio_transcription: {
            model: "whisper-1",
          },
          temperature: 0.7,
          max_response_output_tokens: 150,
        },
      };

      openaiWs.send(JSON.stringify(sessionUpdate));

      // Send initial greeting
      const greeting = {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Greet the caller and ask if they are calling to schedule HVAC service or have questions about services.",
            },
          ],
        },
      };
      openaiWs.send(JSON.stringify(greeting));

      // Trigger response
      openaiWs.send(JSON.stringify({ type: "response.create" }));

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

            // Extract data from what caller said
            if (connection) {
              extractDataFromTranscript(
                event.transcript,
                connection.conversationData
              );

              // Check if we have all data and should save
              const data = connection.conversationData;
              if (
                data.callType === "work_order" &&
                data.name &&
                data.address &&
                data.issue
              ) {
                await saveConversationToSupabase(data);
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
    callType: null,
    name: null,
    phone: null,
    address: null,
    issue: null,
    systemType: null,
    priority: null,
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
