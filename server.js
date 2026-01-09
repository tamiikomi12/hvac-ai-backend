const express = require("express");
const axios = require("axios");

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

// ========================
// Twilio Voice Webhook
// ========================
app.post("/voice", async (req, res) => {
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
});

// ========================
// Process Speech
// ========================
app.post("/process-speech", async (req, res) => {
  const speech = req.body.SpeechResult || "";

  console.log("🗣️ Caller said:", speech);

  try {
    await axios.post(
      "https://tamigoated.app.n8n.cloud/webhook-test/incoming-message",
      {
        caller_message: speech,
        source: "twilio",
      }
    );
  } catch (err) {
    console.error("❌ n8n webhook failed:", err.message);
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
});

// ========================
// Start Server (Render-safe)
// ========================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});


