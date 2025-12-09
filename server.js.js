const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// This receives Twilio's webhook when someone calls
app.post("/voice", async (req, res) => {
    console.log("Incoming call webhook:", req.body);

    // Twilio expects XML (TwiML) back
    const twiml = `
        <Response>
            <Say voice="Polly.Joanna">
                Hi, this is your AI assistant. 
                Please describe your issue and I will help you.
            </Say>
            <Gather input="speech" action="/process-speech" language="en-US"/>
        </Response>
    `;

    res.type("text/xml");
    res.send(twiml);
});

// Twilio sends back the captured speech
app.post("/process-speech", async (req, res) => {
    const speech = req.body.SpeechResult || "";

    console.log("User said:", speech);

    // Forward to your n8n workflow for understanding
    await axios.post("https://tamigoated.app.n8n.cloud/webhook-test/incoming-message", {
        caller_message: speech,
    });

    const twiml = `
        <Response>
            <Say voice="Polly.Joanna">
                Thank you! A technician will contact you shortly.
            </Say>
            <Hangup/>
        </Response>
    `;

    res.type("text/xml");
    res.send(twiml);
});

app.listen(3000, () => console.log("Server running on port 3000"));
