const mongoose = require('mongoose');


const notificationchema = mongoose.Schema({
    title:{
        type: String,
        required: true,
        trim: true,
    },
    body:{
        type: String,
        required: true,
        trim:true,
    },
    type:{
        type: String,
        required: true,
        trim:true,
    },
    link:{
        type: String,
        required: true,
        trim:true,
    },
    Qanswer:{
        type: String,
        required: false,
        trim:true,
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: false,
    },
   

}, { timestamps: true });

notificationchema.index({ createdAt: -1 });

const Notifi = mongoose.model("Notifi",notificationchema);
module.exports = Notifi;