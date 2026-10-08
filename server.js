require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const { User, Faq, Chat, Unanswered } = require('./models');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SECRET = process.env.JWT_SECRET || 'change-this-secret';
const PORT = process.env.PORT || 3000;

/* ---------- Database + first-time setup ---------- */
const SAMPLE_FAQS = [
  { question: 'What are the college timings?', answer: 'College runs Monday to Saturday, 9:00 AM to 4:00 PM.', category: 'General', keywords: ['time', 'timing', 'hours', 'schedule'] },
  { question: 'How can I pay my fees?', answer: 'Fees can be paid at the accounts office (10 AM to 2 PM) or online through the college portal.', category: 'Fees', keywords: ['fee', 'fees', 'payment', 'pay'] },
  { question: 'When are the exams?', answer: 'Exam dates are published on the notice board and the college portal at least 2 weeks before exams.', category: 'Exams', keywords: ['exam', 'exams', 'date', 'datesheet'] },
  { question: 'How do I get my ID card?', answer: 'Visit the admin office with your admission receipt and one passport photo.', category: 'General', keywords: ['id', 'card', 'identity'] },
  { question: 'What are the hostel rules?', answer: 'Hostel gates close at 9:00 PM. Visitors are allowed only in the common room.', category: 'Hostel', keywords: ['hostel', 'rules', 'gate', 'room'] }
];

mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('MongoDB connected');
    const email = (process.env.ADMIN_EMAIL || '').toLowerCase();
    if (email && process.env.ADMIN_PASSWORD && !(await User.findOne({ email }))) {
      await User.create({ email, password: await bcrypt.hash(process.env.ADMIN_PASSWORD, 10), role: 'admin' });
      console.log('Admin user created:', email);
    }
    if ((await Faq.countDocuments()) === 0) {
      await Faq.insertMany(SAMPLE_FAQS);
      console.log('Sample FAQs added');
    }
  })
  .catch(err => console.error('DB error:', err.message));

/* ---------- Matching logic ---------- */
const STOP = new Set(['the', 'is', 'are', 'of', 'to', 'for', 'in', 'a', 'an', 'what', 'when', 'how', 'do', 'i', 'my', 'me', 'can', 'please', 'kya', 'hai', 'ka', 'ki', 'ke', 'mein', 'kab', 'kaise', 'batao', 'bata', 'mujhe', 'hota', 'hoga', 'se', 'ko', 'aur']);

const tokens = s => (s || '').toLowerCase()
  .replace(/[^a-z0-9\u0900-\u097f\s]/g, ' ')
  .split(/\s+/)
  .filter(w => w.length > 1 && !STOP.has(w));

function score(question, faq) {
  const qt = [...new Set(tokens(question))];
  if (!qt.length) return 0;
  const ft = tokens(faq.question + ' ' + (faq.keywords || []).join(' '));
  let hit = 0;
  for (const w of qt) {
    if (ft.includes(w)) hit += 1;
    else if (w.length > 3 && ft.some(f => f.length > 3 && (f.startsWith(w) || w.startsWith(f)))) hit += 0.7;
  }
  return hit / qt.length;
}

async function askGemini(question, faqs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const context = faqs.map((f, i) => `${i + 1}. Q: ${f.question}\n   A: ${f.answer}`).join('\n');
  const prompt = `You are a friendly college helper chatbot. Answer the student's question ONLY using the FAQ below. Keep it short and clear. Reply in the same language/style the student used (English, Hindi or Hinglish). If the FAQ does not contain the answer, reply exactly: NOT_FOUND\n\nFAQ:\n${context}\n\nStudent question: ${question}`;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const d = await r.json();
    const text = d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return text && !text.includes('NOT_FOUND') ? text : null;
  } catch (e) {
    console.error('AI error:', e.message);
    return null;
  }
}

/* ---------- Public API (student chat) ---------- */
app.post('/api/chat', async (req, res) => {
  try {
    const message = (req.body.message || '').trim().slice(0, 300);
    const sessionId = req.body.sessionId || 'anon';
    if (!message) return res.status(400).json({ error: 'Message required' });

    const faqs = await Faq.find({ active: true });
    const ranked = faqs.map(f => ({ f, s: score(message, f) })).sort((a, b) => b.s - a.s);

    let answer, source, faqId;
    if (ranked[0] && ranked[0].s >= 0.6) {
      answer = ranked[0].f.answer;
      source = 'faq';
      faqId = ranked[0].f._id;
      await Faq.updateOne({ _id: faqId }, { $inc: { hits: 1 } });
    } else {
      const ai = await askGemini(message, ranked.slice(0, 6).map(x => x.f));
      if (ai) {
        answer = ai;
        source = 'ai';
      } else {
        answer = 'Sorry, mujhe iska answer abhi nahi pata. Aapka sawal admin ko bhej diya gaya hai.';
        source = 'none';
        await Unanswered.create({ question: message });
      }
    }
    const chat = await Chat.create({ sessionId, question: message, answer, source, faqId });
    res.json({ answer, source, chatId: chat._id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/suggestions', async (req, res) => {
  const list = await Faq.find({ active: true }).sort({ hits: -1 }).limit(6).select('question');
  res.json(list.map(f => f.question));
});

app.get('/api/history/:sessionId', async (req, res) => {
  const list = await Chat.find({ sessionId: req.params.sessionId }).sort({ createdAt: 1 }).limit(50);
  res.json(list);
});

app.post('/api/feedback', async (req, res) => {
  const value = Number(req.body.value) === 1 ? 1 : -1;
  await Chat.updateOne({ _id: req.body.chatId }, { feedback: value });
  res.json({ ok: true });
});

/* ---------- Admin API ---------- */
app.post('/api/admin/login', async (req, res) => {
  const email = (req.body.email || '').toLowerCase();
  const user = await User.findOne({ email });
  if (!user || !(await bcrypt.compare(req.body.password || '', user.password))) {
    return res.status(400).json({ error: 'Wrong email or password' });
  }
  res.json({ token: jwt.sign({ id: user._id, role: user.role }, SECRET, { expiresIn: '7d' }) });
});

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    const data = jwt.verify(token, SECRET);
    if (data.role !== 'admin') throw new Error('not admin');
    req.user = data;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}
app.use('/api/admin', auth);

app.get('/api/admin/stats', async (req, res) => {
  const since = new Date(Date.now() - 6 * 864e5);
  since.setHours(0, 0, 0, 0);
  const [chats, faqs, open, likes, dislikes, perDay] = await Promise.all([
    Chat.countDocuments(),
    Faq.countDocuments(),
    Unanswered.countDocuments({ resolved: false }),
    Chat.countDocuments({ feedback: 1 }),
    Chat.countDocuments({ feedback: -1 }),
    Chat.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, n: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ])
  ]);
  res.json({ chats, faqs, open, likes, dislikes, perDay });
});

const clean = b => ({
  question: b.question,
  answer: b.answer,
  category: b.category || 'General',
  keywords: Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(',').map(s => s.trim()).filter(Boolean),
  active: b.active !== false
});

app.get('/api/admin/faqs', async (req, res) => res.json(await Faq.find().sort({ createdAt: -1 })));
app.post('/api/admin/faqs', async (req, res) => res.json(await Faq.create(clean(req.body))));
app.put('/api/admin/faqs/:id', async (req, res) => res.json(await Faq.findByIdAndUpdate(req.params.id, clean(req.body), { new: true })));
app.delete('/api/admin/faqs/:id', async (req, res) => { await Faq.findByIdAndDelete(req.params.id); res.json({ ok: true }); });

app.get('/api/admin/unanswered', async (req, res) => res.json(await Unanswered.find({ resolved: false }).sort({ createdAt: -1 })));
app.post('/api/admin/unanswered/:id/answer', async (req, res) => {
  const item = await Unanswered.findById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  await Faq.create({ question: item.question, answer: req.body.answer, category: req.body.category || 'General', keywords: [] });
  item.resolved = true;
  await item.save();
  res.json({ ok: true });
});
app.delete('/api/admin/unanswered/:id', async (req, res) => { await Unanswered.findByIdAndDelete(req.params.id); res.json({ ok: true }); });

app.get('/api/admin/chats', async (req, res) => res.json(await Chat.find().sort({ createdAt: -1 }).limit(100)));

app.listen(PORT, () => console.log('Server running on port ' + PORT));