const express = require("express");
const OpenAI = require("openai");
const axios = require("axios");
const Airtable = require("airtable");

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
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY || "patuKEhq1qfxRU5R8";
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || "apprVWTVIFlQYCov3";

// Initialize OpenAI client
if (!OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY not set. OpenAI features will not work.");
}
const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

// Initialize Airtable
const airtableBase = AIRTABLE_API_KEY && AIRTABLE_BASE_ID
  ? new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID)
  : null;

if (airtableBase) {
  console.log("✅ Airtable configured");
} else {
  console.warn("⚠️ Airtable not configured");
}

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
      return "You are AVA, an AI assistant for an HVAC company. Greet the caller warmly and ask if they are calling to schedule HVAC service or if they have questions about pricing and services. Keep it brief and friendly.";

    case CONVERSATION_STATES.GET_NAME:
      return "You are AVA. The caller wants to schedule service. Ask for their name in a friendly way. Keep it brief.";

    case CONVERSATION_STATES.GET_PHONE:
      return `You are AVA. You're speaking with ${collectedData.name || "the caller"}. Ask for their phone number in a friendly way. Keep it brief.`;

    case CONVERSATION_STATES.GET_ADDRESS:
      return `You are AVA. You're speaking with ${collectedData.name || "the caller"}. Ask for the address where they need HVAC service. Keep it brief.`;

    case CONVERSATION_STATES.GET_ISSUE:
      return `You are AVA, a receptionist for an HVAC company. You're speaking with ${collectedData.name || "the caller"}. Ask them to briefly describe what's happening with their HVAC system. DO NOT provide troubleshooting advice or solutions. DO NOT list steps they can try. Just acknowledge their issue and move on. Keep it very brief - one sentence to ask, then listen.`;

    case CONVERSATION_STATES.CONFIRM:
      return `You are AVA, a receptionist. Briefly confirm you've noted their issue: ${collectedData.issue}. Tell them a technician will call them back within 2 hours at ${collectedData.phone} to schedule service at ${collectedData.address}. Ask if there's anything else to note for the technician. DO NOT provide troubleshooting advice. Keep it brief and professional - 2-3 sentences max.`;

    case CONVERSATION_STATES.LEAD_INQUIRY:
      return "You are AVA. The caller is asking for information about HVAC services. Answer their questions helpfully and ask if you can take their contact information for follow-up. Keep responses brief.";

    default:
      return "You are AVA, a helpful AI assistant for HVAC services. Be concise and friendly.";
  }
}

// Helper: Save collected data to Airtable
async function saveToAirtable(collectedData, callerPhoneNumber) {
  if (!airtableBase) {
    console.error("❌ Airtable not configured");
    return;
  }

  try {
    console.log("💾 Saving to Airtable:", collectedData);

    if (collectedData.callType === "work_order") {
      // First, check if customer exists by phone number
      let customerId = null;

      try {
        const existingCustomers = await airtableBase("Customers")
          .select({
            filterByFormula: `{Phone Number} = "${collectedData.phone}"`,
            maxRecords: 1,
          })
          .firstPage();

        if (existingCustomers && existingCustomers.length > 0) {
          customerId = existingCustomers[0].id;
          console.log("✅ Found existing customer:", customerId);
        }
      } catch (err) {
        console.log("ℹ️ No existing customer found, will create new");
      }

      // If customer doesn't exist, create new customer
      if (!customerId) {
        const newCustomer = await airtableBase("Customers").create([
          {
            fields: {
              "Customer Name": collectedData.name,
              "Phone Number": collectedData.phone,
              "Primary Address": collectedData.address,
              "Customer Type": "Residential",
              "Source": "Direct Work Order",
            },
          },
        ]);
        customerId = newCustomer[0].id;
        console.log("✅ Created new customer:", customerId);
      }

      // Create work order
      const workOrder = await airtableBase("Work Orders").create([
        {
          fields: {
            Customer: [customerId],
            "Service Address": collectedData.address,
            "Issue Description": collectedData.issue,
            "System Type": collectedData.systemType,
            Priority: collectedData.priority,
            Status: "New",
          },
        },
      ]);

      console.log("✅ Created work order:", workOrder[0].id);
    } else if (collectedData.callType === "lead") {
      // Save as lead
      const lead = await airtableBase("Leads").create([
        {
          fields: {
            "Lead Name": collectedData.name || "Unknown",
            "Phone Number": collectedData.phone || callerPhoneNumber,
            Notes: collectedData.issue || "General inquiry",
            Status: "New",
            "Inquiry Type": "General Question",
          },
        },
      ]);

      console.log("✅ Created lead:", lead[0].id);
    }
  } catch (err) {
    console.error("❌ Error saving to Airtable:", err);
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
  try {
    const callSid = req.body.CallSid;
    console.log("📞 Incoming call, CallSid:", callSid);

    // Initialize conversation for this call
    if (callSid) {
      conversations.set(callSid, {
        history: [],
        lastActive: Date.now(),
        state: CONVERSATION_STATES.GREETING,
        collectedData: {
          callType: null,
          name: null,
          phone: req.body.From || null, // Auto-capture from Twilio
          address: null,
          issue: null,
          systemType: null,
          priority: null,
        },
      });
    }

    // Put initial Say inside Gather, with fallback
    const twiml = `
<Response>
  <Gather 
    input="speech"
    action="${BASE_URL}/process-speech"
    method="POST"
    speechTimeout="auto"
    timeout="6"
    language="en-US"
  >
    <Say voice="Polly.Joanna" rate="110%">Hi, this is AVA. Please tell me what's going on with your HVAC.</Say>
  </Gather>
  <Say voice="Polly.Joanna" rate="110%">Sorry, I didn't catch that. Please call again.</Say>
</Response>
`.trim();

    res.type("text/xml");
    res.send(twiml);
  } catch (err) {
    console.error("❌ Error in /voice route:", err);
    res.status(500).type("text/xml").send(
      `<Response>
        <Say voice="Polly.Joanna" rate="110%">Sorry, there was an error processing your call. Please try again later.</Say>
        <Hangup/>
      </Response>`
    );
  }
});

// ========================
// Process Speech
// ========================
app.post("/process-speech", async (req, res) => {
  try {
    const speech = req.body.SpeechResult || "";
    const callSid = req.body.CallSid;

    console.log("🗣️ Caller said:", speech);
    console.log("📞 CallSid:", callSid);

    if (!callSid) {
      console.error("❌ No CallSid provided");
      return res.status(400).type("text/xml").send(
        `<Response>
          <Say voice="Polly.Joanna" rate="110%">Sorry, there was an error. Please call again.</Say>
          <Hangup/>
        </Response>`
      );
    }

    // Check for goodbye/stop commands
    const speechLower = speech.toLowerCase().trim();
    if (speechLower === "goodbye" || speechLower === "stop" || speechLower === "bye") {
      conversations.delete(callSid);
      return res.type("text/xml").send(
        `<Response>
          <Say voice="Polly.Joanna" rate="110%">Goodbye! Have a great day.</Say>
          <Hangup/>
        </Response>`
      );
    }

    // Get or create conversation
    let conversation = conversations.get(callSid);
    if (!conversation) {
      conversation = {
        history: [],
        lastActive: Date.now(),
        state: CONVERSATION_STATES.GREETING,
        collectedData: {
          callType: null,
          name: null,
          phone: req.body.From || null, // Auto-capture from Twilio
          address: null,
          issue: null,
          systemType: null,
          priority: null,
        },
      };
      conversations.set(callSid, conversation);
    }

    // Update last active time
    conversation.lastActive = Date.now();

    const currentState = conversation.state;
    const collectedData = conversation.collectedData;

    console.log(`📍 Current state: ${currentState}`);

    // STATE MACHINE LOGIC
    let nextState = currentState;
    let assistantReply = "";

    // Process based on current state
    switch (currentState) {
      case CONVERSATION_STATES.GREETING:
        // Initial greeting - move to determine call type
        nextState = CONVERSATION_STATES.DETERMINE_CALL_TYPE;
        break;

      case CONVERSATION_STATES.DETERMINE_CALL_TYPE:
        // Extract whether this is a work order or lead
        const callType = await extractDataFromResponse(speech, "callType");
        console.log(`🎯 Extracted call type: ${callType}`);

        if (callType && callType.toLowerCase().includes("work")) {
          collectedData.callType = "work_order";
          nextState = CONVERSATION_STATES.GET_NAME;
        } else if (callType && callType.toLowerCase().includes("lead")) {
          collectedData.callType = "lead";
          nextState = CONVERSATION_STATES.LEAD_INQUIRY;
        } else {
          // Couldn't determine, ask again
          nextState = CONVERSATION_STATES.DETERMINE_CALL_TYPE;
        }
        break;

      case CONVERSATION_STATES.GET_NAME:
        // Extract name
        const name = await extractDataFromResponse(speech, "name");
        console.log(`🎯 Extracted name: ${name}`);

        if (name && name.length > 1) {
          collectedData.name = name;
          nextState = CONVERSATION_STATES.GET_ADDRESS; // Skip phone, go straight to address
        } else {
          // Didn't get valid name, ask again
          nextState = CONVERSATION_STATES.GET_NAME;
        }
        break;

      // case CONVERSATION_STATES.GET_PHONE:
      //   // No longer needed - phone is auto-captured from Twilio
      //   break;

      case CONVERSATION_STATES.GET_ADDRESS:
        // Extract address
        const address = await extractDataFromResponse(speech, "address");
        console.log(`🎯 Extracted address: ${address}`);

        if (address && address.length > 5) {
          collectedData.address = address;
          nextState = CONVERSATION_STATES.GET_ISSUE;
        } else {
          // Didn't get valid address, ask again
          nextState = CONVERSATION_STATES.GET_ADDRESS;
        }
        break;

      case CONVERSATION_STATES.GET_ISSUE:
        // Save the issue description as-is
        collectedData.issue = speech;
        collectedData.systemType = determineSystemType(speech);
        collectedData.priority = determinePriority(speech);

        console.log(`🎯 Issue: ${speech}`);
        console.log(`🎯 System Type: ${collectedData.systemType}`);
        console.log(`🎯 Priority: ${collectedData.priority}`);

        nextState = CONVERSATION_STATES.CONFIRM;
        break;

      case CONVERSATION_STATES.CONFIRM:
        // Save to Airtable and complete
        await saveToAirtable(collectedData, req.body.From);
        nextState = CONVERSATION_STATES.COMPLETE;
        break;

      case CONVERSATION_STATES.LEAD_INQUIRY:
        // Handle lead conversation - for now just have a conversation
        // We'll enhance this later
        break;

      case CONVERSATION_STATES.COMPLETE:
        // Done - thank them and hang up
        conversations.delete(callSid);
        return res.type("text/xml").send(
          `<Response>
            <Say voice="Polly.Joanna" rate="110%">Thank you for calling. Have a great day!</Say>
            <Hangup/>
          </Response>`
        );
    }

    // Update state
    conversation.state = nextState;
    console.log(`➡️  Next state: ${nextState}`);

    // Generate response using OpenAI based on new state
    if (!openai) {
      assistantReply =
        "I'm sorry, but I'm not properly configured right now. Please contact support directly.";
    } else {
      try {
        const systemPrompt = getPromptForState(nextState, collectedData);

        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: speech },
        ];

        const completion = await openai.chat.completions.create({
          model: OPENAI_MODEL,
          messages: messages,
          temperature: 0.7,
          max_tokens: 150,
        });

        assistantReply = completion.choices[0]?.message?.content || "";

        if (!assistantReply) {
          throw new Error("Empty response from OpenAI");
        }
      } catch (err) {
        console.error("❌ OpenAI error:", err.message);
        assistantReply =
          "I'm sorry, I'm having trouble processing that right now. Could you try again?";
      }
    }

    const escapedReply = escapeXml(assistantReply);

    // Log to n8n (non-blocking)
    if (N8N_WEBHOOK_URL) {
      try {
        const logData = {
          callSid: callSid,
          from: req.body.From,
          transcript: speech,
          ai_reply: assistantReply,
          timestamp: new Date().toISOString(),
        };

        const resp = await axios.post(N8N_WEBHOOK_URL, logData);
        console.log("✅ Logged to n8n:", resp.status);
      } catch (err) {
        console.error("❌ n8n logging failed:", err.response?.status, err.response?.data || err.message);
        // Don't break the call if n8n fails
      }
    }

    // Return TwiML
    const twiml = `
<Response>
  <Say voice="Polly.Joanna" rate="110%">${escapedReply}</Say>
  <Gather 
    input="speech"
    action="${BASE_URL}/process-speech"
    method="POST"
    speechTimeout="auto"
    timeout="5"
    language="en-US"
  />
  <Say voice="Polly.Joanna" rate="110%">I didn't hear anything. If you're done, just say goodbye.</Say>
  <Gather 
    input="speech"
    action="${BASE_URL}/process-speech"
    method="POST"
    speechTimeout="auto"
    timeout="5"
    language="en-US"
  />
  <Say voice="Polly.Joanna" rate="110%">Goodbye.</Say>
  <Hangup/>
</Response>
`.trim();

    res.type("text/xml");
    res.send(twiml);
  } catch (err) {
    console.error("❌ Error in /process-speech route:", err);
    res.status(500).type("text/xml").send(
      `<Response>
        <Say voice="Polly.Joanna" rate="110%">Sorry, there was an error. Please try again.</Say>
        <Hangup/>
      </Response>`
    );
  }
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
// Start Server (Render-safe)
// ========================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`📍 Root: http://0.0.0.0:${PORT}/`);
  if (openai) {
    console.log(`✅ OpenAI configured with model: ${OPENAI_MODEL}`);
  } else {
    console.log(`⚠️  OpenAI not configured. Set OPENAI_API_KEY environment variable.`);
  }
}).on("error", (err) => {
  console.error("❌ Failed to start server:", err);
  process.exit(1);
});
