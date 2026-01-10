const express = require("express");
const OpenAI = require("openai");
const axios = require("axios");

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
const BASE_URL =
  process.env.BASE_URL || `http://localhost:${PORT}`;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

// Initialize OpenAI client
if (!OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY not set. OpenAI features will not work.");
}
const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

// ========================
// Conversation Store
// ========================
// In-memory store: { CallSid: { history: [...], lastActive: timestamp } }
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
        history: [
          {
            role: "system",
            content:
              "You are AVA, a helpful AI assistant for HVAC services. Be concise and friendly in your responses, suitable for voice conversation. Keep responses under 3 sentences when possible.",
          },
        ],
        lastActive: Date.now(),
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
    <Say voice="Polly.Joanna">Hi, this is AVA. Please tell me what's going on with your HVAC.</Say>
  </Gather>
  <Say voice="Polly.Joanna">Sorry, I didn't catch that. Please call again.</Say>
</Response>
`.trim();

    res.type("text/xml");
    res.send(twiml);
  } catch (err) {
    console.error("❌ Error in /voice route:", err);
    res.status(500).type("text/xml").send(
      `<Response>
        <Say voice="Polly.Joanna">Sorry, there was an error processing your call. Please try again later.</Say>
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
          <Say voice="Polly.Joanna">Sorry, there was an error. Please call again.</Say>
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
          <Say voice="Polly.Joanna">Goodbye! Have a great day.</Say>
          <Hangup/>
        </Response>`
      );
    }

    // Get or create conversation
    let conversation = conversations.get(callSid);
    if (!conversation) {
      conversation = {
        history: [
          {
            role: "system",
            content:
              "You are AVA, a helpful AI assistant for HVAC services. Be concise and friendly in your responses, suitable for voice conversation. Keep responses under 3 sentences when possible.",
          },
        ],
        lastActive: Date.now(),
      };
      conversations.set(callSid, conversation);
    }

    // Update last active time
    conversation.lastActive = Date.now();

    // Append user message to history
    conversation.history.push({
      role: "user",
      content: speech,
    });

    // Call OpenAI
    let assistantReply = "";
    if (!openai) {
      assistantReply =
        "I'm sorry, but I'm not properly configured right now. Please contact support directly.";
      console.error("❌ OpenAI client not initialized");
    } else {
      try {
        console.log("🤖 Calling OpenAI with history length:", conversation.history.length);

        const completion = await openai.chat.completions.create({
          model: OPENAI_MODEL,
          messages: conversation.history,
          temperature: 0.7,
          max_tokens: 200, // Keep responses short for voice
        });

        assistantReply = completion.choices[0]?.message?.content || "";
        console.log("✅ OpenAI response:", assistantReply.substring(0, 100) + "...");

        if (!assistantReply) {
          throw new Error("Empty response from OpenAI");
        }

        // Append assistant reply to history
        conversation.history.push({
          role: "assistant",
          content: assistantReply,
        });
      } catch (err) {
        console.error("❌ OpenAI error:", err.message);
        assistantReply =
          "I'm sorry, I'm having trouble processing that right now. Could you try again?";
        // Don't append error to history, just use fallback message
      }
    }

    // Escape XML in the reply
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

    // Return TwiML with Say and Gather (loop)
    const twiml = `
<Response>
  <Say voice="Polly.Joanna">${escapedReply}</Say>
  <Gather 
    input="speech"
    action="${BASE_URL}/process-speech"
    method="POST"
    speechTimeout="auto"
    timeout="5"
    language="en-US"
  />
  <Say voice="Polly.Joanna">I didn't hear anything. If you're done, just say goodbye.</Say>
  <Gather 
    input="speech"
    action="${BASE_URL}/process-speech"
    method="POST"
    speechTimeout="auto"
    timeout="5"
    language="en-US"
  />
  <Say voice="Polly.Joanna">Goodbye.</Say>
  <Hangup/>
</Response>
`.trim();

    res.type("text/xml");
    res.send(twiml);
  } catch (err) {
    console.error("❌ Error in /process-speech route:", err);
    res.status(500).type("text/xml").send(
      `<Response>
        <Say voice="Polly.Joanna">Sorry, there was an error processing your message. Please try again.</Say>
        <Gather 
          input="speech"
          action="${BASE_URL}/process-speech"
          method="POST"
          speechTimeout="auto"
          timeout="5"
          language="en-US"
        />
        <Say voice="Polly.Joanna">Goodbye.</Say>
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
