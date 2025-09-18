// ===================================
// Load Environment Variables
// ===================================
require("dotenv").config({ path: __dirname + "/.env" });
console.log("Loaded MONGO_URI:", process.env.MONGO_URI);

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();

// ===================================
// Middleware
// ===================================
app.use(cors());
app.use(express.json());

// ===================================
// Create HTTP Server for Socket.IO
// ===================================
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ===================================
// MongoDB Connection
// ===================================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err));

// ===================================
// MODELS
// ===================================

// === USER MODEL ===
const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: "student" } // student, tutor, admin
});
const User = mongoose.model("User", UserSchema);

// === CHAT MESSAGE MODEL ===
const ChatSchema = new mongoose.Schema({
  name: { type: String, required: true },
  text: { type: String, required: true },
  time: { type: String, required: true },
  room: { type: String, default: "General" },
}, { timestamps: true });
const ChatMessage = mongoose.model("ChatMessage", ChatSchema);

// === NOTIFICATION MODEL ===
const NotificationSchema = new mongoose.Schema({
  message: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  read: { type: Boolean, default: false },
}, { timestamps: true });
const Notification = mongoose.model("Notification", NotificationSchema);

// === COURSE MODEL ===
const CourseSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: String,
  materials: [String], // list of files or links
  tutor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true });
const Course = mongoose.model("Course", CourseSchema);

// ===================================
// AUTH ROUTES
// ===================================

// === SIGNUP ===
app.post("/api/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ message: "User already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({ name, email, password: hashedPassword });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "1h" });

    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error("❌ Signup Error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// === LOGIN ===
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: "Invalid credentials" });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "1h" });

    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error("❌ Login Error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// === GET CURRENT USER ===
app.get("/api/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: "No token provided" });

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id).select("-password");
    res.json(user);
  } catch (err) {
    console.error("❌ Auth Error:", err);
    res.status(401).json({ message: "Invalid token" });
  }
});

// ===================================
// FEATURE 4: LIVE VIDEO CLASS TOKENS
// ===================================
app.get("/api/live/token", (req, res) => {
  const token = jwt.sign(
    { room: "CodeForge-Live-Class", role: "student" },
    process.env.JWT_SECRET,
    { expiresIn: "2h" }
  );
  res.json({ token });
});

// ===================================
// FEATURE 5: NOTIFICATIONS
// ===================================
async function sendNotification(userId, message) {
  const notification = await Notification.create({ userId, message });
  io.emit("notification", notification);
}

// Get notifications
app.get("/api/notifications/:userId", async (req, res) => {
  const notifications = await Notification.find({ userId: req.params.userId }).sort({ createdAt: -1 });
  res.json(notifications);
});

// ===================================
// FEATURE 6: COURSE MANAGEMENT
// ===================================

// Create a course
app.post("/api/courses", async (req, res) => {
  const { title, description, materials, tutor } = req.body;
  const course = await Course.create({ title, description, materials, tutor });
  res.json(course);
});

// Get all courses
app.get("/api/courses", async (req, res) => {
  const courses = await Course.find().populate("tutor", "name email");
  res.json(courses);
});

// ===================================
// FEATURE 7: AI CODING ASSISTANT
// ===================================
app.post("/api/ai/help", async (req, res) => {
  const { code, question } = req.body;

  try {
    const aiRes = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: "You are a coding assistant." },
          { role: "user", content: `Code:\n${code}\n\nQuestion:\n${question}` }
        ]
      },
      {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
      }
    );

    res.json({ answer: aiRes.data.choices[0].message.content });
  } catch (err) {
    console.error("❌ AI Assistant Error:", err.message);
    res.status(500).json({ error: "AI assistant failed", details: err.message });
  }
});

// ===================================
// FEATURE 8: PAYMENT (Stripe)
// ===================================
app.post("/api/payment", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "Premium CodeForge Subscription",
            },
            unit_amount: 999, // $9.99
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: "http://localhost:8080/success.html",
      cancel_url: "http://localhost:8080/cancel.html",
    });

    res.json({ id: session.id });
  } catch (err) {
    console.error("❌ Payment Error:", err);
    res.status(500).json({ error: "Payment failed", details: err.message });
  }
});

// ===================================
// CHAT ROUTES
// ===================================
app.get("/api/chat/messages/:room", async (req, res) => {
  try {
    const messages = await ChatMessage.find({ room: req.params.room })
      .sort({ createdAt: 1 })
      .limit(50);
    res.json(messages);
  } catch (err) {
    console.error("❌ Fetch chat messages error:", err.message);
    res.status(500).json({ message: "Server error fetching chat messages" });
  }
});

// ===================================
// SOCKET.IO EVENTS
// ===================================
io.on("connection", (socket) => {
  console.log("⚡ A user connected");

  socket.on("joinRoom", (room) => {
    socket.join(room);
    console.log(`📚 User joined room: ${room}`);
  });

  socket.on("chatMessage", async (data) => {
    try {
      console.log(`💬 [${data.room}] ${data.name}: ${data.text}`);

      const chatMessage = new ChatMessage(data);
      await chatMessage.save();

      io.to(data.room).emit("chatMessage", data);

      await sendNotification(null, `New message from ${data.name} in ${data.room}`);
    } catch (err) {
      console.error("❌ Chat save error:", err.message);
    }
  });

  socket.on("disconnect", () => {
    console.log("❌ User disconnected");
  });
});

// ===================================
// START SERVER
// ===================================
const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
