const mongoose = require('mongoose');
const { Schema } = mongoose;

const User = mongoose.model('User', new Schema({
  email: { type: String, unique: true, lowercase: true, required: true },
  password: { type: String, required: true },
  role: { type: String, default: 'admin' }
}, { timestamps: true }));

const Faq = mongoose.model('Faq', new Schema({
  question: { type: String, required: true },
  answer: { type: String, required: true },
  category: { type: String, default: 'General' },
  keywords: [String],
  active: { type: Boolean, default: true },
  hits: { type: Number, default: 0 }
}, { timestamps: true }));

const Chat = mongoose.model('Chat', new Schema({
  sessionId: String,
  question: String,
  answer: String,
  source: { type: String, enum: ['faq', 'ai', 'none'], default: 'faq' },
  faqId: Schema.Types.ObjectId,
  feedback: { type: Number, default: 0 } // 1 = helpful, -1 = not helpful
}, { timestamps: true }));

const Unanswered = mongoose.model('Unanswered', new Schema({
  question: String,
  resolved: { type: Boolean, default: false }
}, { timestamps: true }));

module.exports = { User, Faq, Chat, Unanswered };