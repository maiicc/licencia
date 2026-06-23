const { Client, IntentsBitField, EmbedBuilder } = require('discord.js');
const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config(); // Esto permite usar variables de entorno

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. CONEXIÓN A MONGODB ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ Conectado a MongoDB Atlas"))
    .catch(err => console.error("❌ Error de MongoDB:", err));

const ClientSchema = new mongoose.Schema({
    robloxId: { type: String, required: true, unique: true },
    addedBy: String,
    date: { type: Date, default: Date.now }
});
const Whitelist = mongoose.model('Whitelist', ClientSchema);

app.use(express.json());

// --- 2. API PARA ROBLOX (ENDPOINT) ---
app.get('/verify/:id', async (req, res) => {
    try {
        const user = await Whitelist.findOne({ robloxId: req.params.id });
        if (user) {
            return res.status(200).json({ allowed: true, message: "Licencia válida" });
        } else {
            return res.status(403).json({ allowed: false, message: "Sin licencia" });
        }
    } catch (error) {
        res.status(500).json({ error: "Error interno" });
    }
});

// --- 3. BOT DE DISCORD ---
const client = new Client({ 
    intents: [
        IntentsBitField.Flags.Guilds, 
        IntentsBitField.Flags.GuildMessages, 
        IntentsBitField.Flags.MessageContent
    ] 
});

const PREFIX = "!"; // Tu comando será !whitelist o !unwhitelist
const ADMIN_ID = process.env.ADMIN_ID; // Tu ID de Discord

client.on('messageCreate', async (msg) => {
    if (!msg.content.startsWith(PREFIX) || msg.author.bot) return;

    const args = msg.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // Solo tú puedes usar estos comandos
    if (msg.author.id !== ADMIN_ID) return;

    if (command === "whitelist") {
        const id = args[0];
        if (!id) return msg.reply("❌ Uso: !whitelist [ID_de_Roblox]");

        try {
            await Whitelist.create({ robloxId: id, addedBy: msg.author.tag });
            msg.reply(`✅ ID **${id}** ha sido añadido a la lista blanca.`);
        } catch (err) {
            msg.reply("❌ Ese ID ya está en la lista o hubo un error.");
        }
    }

    if (command === "unwhitelist") {
        const id = args[0];
        if (!id) return msg.reply("❌ Uso: !unwhitelist [ID_de_Roblox]");

        await Whitelist.deleteOne({ robloxId: id });
        msg.reply(`🗑️ ID **${id}** eliminado de la lista blanca.`);
    }
});

client.login(process.env.BOT_TOKEN);
app.listen(PORT, () => console.log(`🚀 Servidor API corriendo en puerto ${PORT}`));