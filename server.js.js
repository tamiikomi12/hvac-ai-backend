const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Render / production base URL (set this as an env var on Render)
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// This receives Twilio's webhook when someone calls
app.post("/voice", async (req, res) => {
  console.log("Incoming call webhook:", req.body);

  const twiml = `
<Response>
  <Say voice="Polly.Joanna">
    Hi, this is your AI assistant.
    Please describe your issue and I will help you.
  </Say>
  <Gather input="speech" action="${BASE_URL}/process-speech" method="POST" language="en-US" />
</Response>`.trim();

  res.type("text/xml");
  res.send(twiml);
});

// Twilio sends back the captured speech
app.post("/process-speech", async (req, res) => {
  const speech = req.body.SpeechResult || "";
  console.log("User said:", speech);

  try {
    await axios.post(
      "https://tamigoated.app.n8n.cloud/webhook-test/incoming-message",
      { caller_message: speech }
    );
  } catch (err) {
    console.error("n8n webhook failed:", err?.message || err);
    // Don’t crash the call if n8n is down
  }

  const twiml = `
<Response>
  <Say voice="Polly.Joanna">
    Thank you! A technician will contact you shortly.
  </Say>
  <Hangup/>
</Response>`.trim();

  res.type("text/xml");
  res.send(twiml);
});

// ✅ Render needs env PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));

