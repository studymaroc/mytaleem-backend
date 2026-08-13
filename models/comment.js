const mongoose = require("mongoose");

const commentSchema = mongoose.Schema({
  examId: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true },
}, { timestamps: true });

commentSchema.index({ examId: 1, createdAt: -1 });
commentSchema.index({ userId: 1, createdAt: -1 });

const Comment = mongoose.model("Comment", commentSchema);
module.exports = Comment;
