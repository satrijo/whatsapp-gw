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
import cors from 'cors';

const app = express();
const server = createServer(app);
const io = new Server(server);

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(cors());

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
  try {
    connectionStatus = 'connecting';
    io.emit('status', { status: connectionStatus });

    const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false, // Matikan QR di terminal
      browser: ["Mac OS", "Safari", "17.4.1"],
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

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (!messages) return;
      if (messages[0].key.fromMe) return;

      console.log('Tipe Update:', type);
      console.log('Pesan Baru:', messages);
    })
  } catch (error) {
    console.error('Error connecting to WhatsApp:', error);
    connectionStatus = 'disconnected';
    io.emit('status', { status: connectionStatus });
  }

}

// Endpoint untuk mengirim pesan
app.post('/send-message', async (req, res) => {
  try {
    const { number, message, group } = req.body;

    // Validasi input
    if (!number || !message) {
      return res.status(400).json({
        status: false,
        message: 'Number dan message harus diisi'
      });
    }

    // Cek koneksi WhatsApp
    if (!sock || connectionStatus !== 'connected') {
      return res.status(500).json({
        status: false,
        message: 'WhatsApp belum terkoneksi'
      });
    }

    // Validasi panjang nomor
    if (!group && number.length < 10) {
      return res.status(400).json({
        status: false,
        message: 'Format nomor tidak valid'
      });
    }

    // Format nomor
    let formattedNumber;
    if (group) {
      formattedNumber = number.includes('@g.us')
        ? number
        : `${number}@g.us`;
    } else {
      formattedNumber = `${number}@s.whatsapp.net`;
    }

    // Kirim pesan
    const sent = await sock.sendMessage(formattedNumber, { text: message });

    if (!sent) {
      throw new Error('Gagal mengirim pesan');
    }

    res.json({
      status: true,
      message: 'Pesan berhasil dikirim',
      data: {
        to: formattedNumber,
        message: message
      }
    });

  } catch (error) {
    console.error('Error sending message:', error);
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
  // console.log('Klien terhubung:', socket.id);

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
const PORT = process.env.PORT || 3333;
server.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
  connectToWhatsApp();
});
