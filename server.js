const express = require("express");
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
// Health & Root
// ========================
app.get("/", (req, res) => {
  res.status(200).send("ok");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// ========================
// Config
// ========================
const PORT = process.env.PORT || 3000;
const BASE_URL =
  process.env.BASE_URL || `http://localhost:${PORT}`;
const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL ||
  "https://tamigoated.app.n8n.cloud/webhook/incoming-message";

// ========================
// Twilio Voice Webhook
// ========================
app.post("/voice", async (req, res) => {
  try {
    console.log("📞 Incoming call:", req.body);

    const twiml = `
<Response>
  <Say voice="Polly.Joanna">
    Hi, this is AVA, your AI assistant for HVAC services.
    Please briefly describe your issue after the tone.
  </Say>
  <Gather 
    input="speech"
    action="${BASE_URL}/process-speech"
    method="POST"
    speechTimeout="auto"
    timeout="5"
    language="en-US"
  />
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

    console.log("🗣️ Caller said:", speech);

    try {
      const resp = await axios.post(N8N_WEBHOOK_URL, {
        caller_message: speech,
        source: "twilio",
      });
      console.log("✅ Sent to n8n:", resp.status);
    } catch (err) {
      console.error("❌ n8n webhook failed:", err.response?.status, err.response?.data);
    }

    const twiml = `
<Response>
  <Say voice="Polly.Joanna">
    Thank you. A technician will contact you shortly.
  </Say>
  <Hangup/>
</Response>
`.trim();

    res.type("text/xml");
    res.send(twiml);
  } catch (err) {
    console.error("❌ Error in /process-speech route:", err);
    res.status(500).type("text/xml").send(
      `<Response>
        <Say voice="Polly.Joanna">Sorry, there was an error processing your message.</Say>
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
}).on("error", (err) => {
  console.error("❌ Failed to start server:", err);
  process.exit(1);
});


