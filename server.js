const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Multer setup for photo uploads
const upload = multer({ dest: 'uploads/', limits: { fileSize: 2 * 1024 * 1024 } });

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/voting', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Mongoose Schemas and Models
const contestantSchema = new mongoose.Schema({
  name: String,
  positionKey: String, // e.g. 'president'
  positionLabel: String, // e.g. 'President'
  photo: String,
  description: String,
  votes: { type: Number, default: 0 },
});
const Contestant = mongoose.model('Contestant', contestantSchema);

const voterSchema = new mongoose.Schema({
  voterId: String,
  votes: { type: Map, of: mongoose.Schema.Types.ObjectId }, // { positionKey: contestantId }
});
const Voter = mongoose.model('Voter', voterSchema);

const settingsSchema = new mongoose.Schema({
  votingOpen: { type: Boolean, default: false }
});
const Settings = mongoose.model('Settings', settingsSchema);

// Serve uploaded photos
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Admin: Add contestant
app.post('/api/contestants', upload.single('photo'), async (req, res) => {
  try {
    const photoPath = req.file ? `/uploads/${req.file.filename}` : '';
    const { name, positionKey, positionLabel, description } = req.body;
    if (!name || !positionKey || !positionLabel || !description) {
      return res.status(400).json({ error: "All fields are required" });
    }
    const newContestant = new Contestant({ name, positionKey, positionLabel, description, photo: photoPath });
    await newContestant.save();
    res.json(newContestant);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all contestants
app.get('/api/contestants', async (req, res) => {
  try {
    const contestants = await Contestant.find();
    res.json(contestants);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Bulk voter registration
app.post('/api/voters', async (req, res) => {
  try {
    const ids = req.body.voterIds || [];
    if (ids.length !== 140) return res.status(400).json({ error: "Must provide exactly 140 voter IDs" });
    await Voter.deleteMany({});
    await Voter.insertMany(ids.map(id => ({ voterId: id, votes: {} })));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Voting state
app.post('/api/voting-state', async (req, res) => {
  try {
    const { open } = req.body;
    let s = await Settings.findOne();
    if (!s) s = new Settings();
    s.votingOpen = !!open;
    await s.save();
    res.json({ votingOpen: s.votingOpen });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get('/api/voting-state', async (req, res) => {
  try {
    let s = await Settings.findOne();
    res.json({ votingOpen: s ? s.votingOpen : false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Voter: Authenticate
app.post('/api/voter-auth', async (req, res) => {
  try {
    const { voterId } = req.body;
    const voter = await Voter.findOne({ voterId });
    if (!voter) return res.status(403).json({ error: "Invalid Voter ID" });
    res.json({ votes: voter.votes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Voter: Submit votes for all positions (only once per position)
app.post('/api/vote', async (req, res) => {
  try {
    const { voterId, votes } = req.body; // votes: { president: contestantId, ... }
    let votingState = await Settings.findOne();
    if (!votingState || !votingState.votingOpen) return res.status(403).json({ error: "Voting is not open" });

    const voter = await Voter.findOne({ voterId });
    if (!voter) return res.status(403).json({ error: "Invalid voter" });

    let updated = false;
    for (const [pos, cid] of Object.entries(votes)) {
      if (!voter.votes.has(pos)) {
        voter.votes.set(pos, cid);
        await Contestant.findByIdAndUpdate(cid, { $inc: { votes: 1 } });
        updated = true;
      }
    }
    if (updated) await voter.save();
    res.json({ success: true, votes: voter.votes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Results: Grouped by position
app.get('/api/results', async (req, res) => {
  try {
    const contestants = await Contestant.find();
    if (!Array.isArray(contestants) || contestants.length === 0) {
      return res.json({});
    }
    const grouped = {};
    contestants.forEach(c => {
      if (!grouped[c.positionKey]) grouped[c.positionKey] = { label: c.positionLabel, list: [] };
      grouped[c.positionKey].list.push({
        _id: c._id, name: c.name, photo: c.photo, votes: c.votes, description: c.description
      });
    });
    res.json(grouped);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Root route (serve index.html)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});
