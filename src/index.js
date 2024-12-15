import express from 'express';
import { Server } from 'socket.io';
import { createServer } from 'http';
import qrcode from 'qrcode';
import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import path from 'path';
import fs from 'fs';

const app = express();
const server = createServer(app);
const io = new Server(server);

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Variabel untuk menyimpan instance WhatsApp socket
let sock = null;

// Variabel untuk melacak status koneksi
let connectionStatus = 'disconnected'; // Bisa 'qr', 'connecting', 'connected'

// Kirim halaman HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// Fungsi untuk menghubungkan ke WhatsApp
async function connectToWhatsApp() {
  connectionStatus = 'connecting';
  io.emit('status', { status: connectionStatus });

  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // Matikan QR di terminal
    browser: ["Mac OS", "Safari", "10.15.7"],
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = 'qr';
      // Convert QR code ke data URL
      const qrCode = await qrcode.toDataURL(qr);
      io.emit('qr', qrCode);
      io.emit('status', { status: connectionStatus });
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(
        "connection closed due to ",
        lastDisconnect.error,
        ", reconnecting ",
        shouldReconnect
      );
      if (shouldReconnect) {
        connectToWhatsApp();
      } else {
        connectionStatus = 'disconnected';
        io.emit('status', { status: connectionStatus });
      }
    } else if (connection === "open") {
      console.log("opened connection");
      connectionStatus = 'connected';
      io.emit('ready', 'WhatsApp sudah terhubung!');
      io.emit('status', { status: connectionStatus });
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

// Endpoint untuk mengirim pesan
app.post('/send-message', async (req, res) => {
  try {
    const { number, message } = req.body;

    if (!sock || connectionStatus !== 'connected') {
      return res.status(500).json({ status: false, message: 'WhatsApp belum terkoneksi' });
    }

    const formattedNumber = number.includes('@s.whatsapp.net')
      ? number
      : `${number}@s.whatsapp.net`;

    await sock.sendMessage(formattedNumber, { text: message });

    res.json({
      status: true,
      message: 'Pesan berhasil dikirim'
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      status: false,
      message: 'Gagal mengirim pesan',
      error: error.message
    });
  }
});

app.get('/sign-out', async (req, res) => {
  try {
    // Tutup koneksi WhatsApp jika ada
    if (sock) {
      await sock.logout();
      sock = null;

      const authPath = path.join(process.cwd(), 'auth_info_baileys');

      // Hapus semua file .json dalam folder auth_info_baileys
      fs.readdirSync(authPath)
        .filter(file => file.endsWith('.json'))
        .forEach(file => {
          fs.unlinkSync(path.join(authPath, file));
        });
    }

    connectionStatus = 'disconnected';
    io.emit('status', { status: connectionStatus });

    res.json({
      status: true,
      message: 'Berhasil sign-out'
    });

    // Mulai kembali koneksi WhatsApp untuk menampilkan QR code
    connectToWhatsApp();
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      status: false,
      message: 'Gagal sign-out',
      error: error.message
    });
  }
});

// Handle Socket.io Connection
io.on('connection', (socket) => {
  console.log('Klien terhubung:', socket.id);

  // Kirim status saat ini ke klien yang baru terhubung
  socket.emit('status', { status: connectionStatus });

  if (connectionStatus === 'qr' && sock) {
    // Jika membutuhkan QR dan ada socket, kirim ulang QR
    sock.ev.on('qr', async (qr) => {
      const qrCode = await qrcode.toDataURL(qr);
      socket.emit('qr', qrCode);
    });
  }

  if (connectionStatus === 'connected') {
    // Jika sudah terkoneksi, kirim 'ready' event
    socket.emit('ready', 'WhatsApp sudah terhubung!');
  }

  socket.on('disconnect', () => {
    console.log('Klien terputus:', socket.id);
  });
});

// Jalankan server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
  connectToWhatsApp();
});
