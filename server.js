const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/voting', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Models
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

// Multer for photo uploads
const upload = multer({ dest: 'uploads/', limits: { fileSize: 2 * 1024 * 1024 } });

// Admin: Add contestant
app.post('/api/contestants', upload.single('photo'), async (req, res) => {
  let photoPath = req.file ? `/uploads/${req.file.filename}` : '';
  const { name, positionKey, positionLabel, description } = req.body;
  const newContestant = new Contestant({ name, positionKey, positionLabel, description, photo: photoPath });
  await newContestant.save();
  res.json(newContestant);
});

// Get all contestants
app.get('/api/contestants', async (req, res) => {
  const contestants = await Contestant.find();
  res.json(contestants);
});

// Admin: Bulk voter registration
app.post('/api/voters', async (req, res) => {
  const ids = req.body.voterIds || [];
  if (ids.length !== 140) return res.status(400).json({error: "Must provide exactly 140 voter IDs"});
  await Voter.deleteMany({});
  await Voter.insertMany(ids.map(id => ({voterId: id, votes: {} })));
  res.json({success: true});
});

// Admin: Voting state
app.post('/api/voting-state', async (req, res) => {
  const { open } = req.body;
  let s = await Settings.findOne();
  if (!s) s = new Settings();
  s.votingOpen = !!open;
  await s.save();
  res.json({ votingOpen: s.votingOpen });
});
app.get('/api/voting-state', async (req, res) => {
  let s = await Settings.findOne();
  res.json({ votingOpen: s ? s.votingOpen : false });
});

// Voter: Authenticate
app.post('/api/voter-auth', async (req, res) => {
  const { voterId } = req.body;
  const voter = await Voter.findOne({ voterId });
  if (!voter) return res.status(403).json({ error: "Invalid Voter ID" });
  res.json({ votes: voter.votes });
});

// Voter: Submit votes for all positions (only once per position)
app.post('/api/vote', async (req, res) => {
  const { voterId, votes } = req.body; // votes: { president: contestantId, secretary: contestantId, ... }
  let votingState = await Settings.findOne();
  if (!votingState || !votingState.votingOpen) return res.status(403).json({ error: "Voting is not open" });

  const voter = await Voter.findOne({ voterId });
  if (!voter) return res.status(403).json({ error: "Invalid voter" });

  // Only allow voting for positions the voter hasn't voted for yet
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
});

// Results: Grouped by position
app.get('/api/results', async (req, res) => {
  const contestants = await Contestant.find();
  const grouped = {};
  contestants.forEach(c => {
    if (!grouped[c.positionKey]) grouped[c.positionKey] = { label: c.positionLabel, list: [] };
    grouped[c.positionKey].list.push({
      _id: c._id, name: c.name, photo: c.photo, votes: c.votes, description: c.description
    });
  });
  res.json(grouped);
});

app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});