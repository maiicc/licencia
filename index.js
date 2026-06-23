const { Client, IntentsBitField, EmbedBuilder } = require('discord.js');
const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config(); // Esto permite usar variables de entorno

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. CONEXIÓN A MONGODB ---
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000 // Falla rápido si no conecta
})
.then(() => console.log("✅ Conectado a MongoDB Atlas con éxito"))
.catch(err => {
    console.error("❌ ERROR CRÍTICO DE CONEXIÓN:");
    console.error(err.message);
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
            // Intentamos crear el registro
            const newEntry = await Whitelist.create({ 
                robloxId: id.toString(), 
                addedBy: msg.author.tag 
            });
            msg.reply(`✅ ID **${id}** añadido con éxito.`);
        } catch (err) {
            console.error(err); // Esto aparecerá en la consola de Railway
            
            if (err.code === 11000) {
                msg.reply("❌ Error: Ese ID ya está en la lista blanca.");
            } else {
                msg.reply(`❌ Error de base de datos: ${err.message}`);
            }
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
