const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Socket.io attaché proprement au serveur HTTP
const io = new Server(server, {
    cors: {
        origin: "*"
    }
});

// 🔥 Fichiers statiques (HTML/CSS/JS)
app.use(express.static(path.join(__dirname, 'public')));

// 🔥 Route principale (sécurisée pour déploiement)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Stockage des parties
const games = {};

io.on('connection', (socket) => {
    console.log(`Joueur connecté : ${socket.id}`);

    // --- CRÉER UNE PARTIE ---
    socket.on('createGame', (pseudo) => {
        let code;
        do {
            code = Math.random().toString(36).substring(2, 6).toUpperCase();
        } while (games[code]);

        games[code] = {
            hostId: socket.id,
            players: [{ id: socket.id, pseudo, role: '', word: '', connected: true }],
            votes: {},
            started: false,
            currentWordPair: null
        };

        socket.join(code);
        socket.emit('gameCreated', { code, players: games[code].players });
    });

    // --- REJOINDRE UNE PARTIE ---
    socket.on('joinGame', ({ code, pseudo }) => {
        const game = games[code];
        if (!game) return socket.emit('errorMsg', "Code incorrect !");
        if (game.started) return socket.emit('errorMsg', "Partie déjà lancée !");

        let finalPseudo = pseudo;

        const exists = game.players.some(p => p.pseudo.toLowerCase() === pseudo.toLowerCase());
        if (exists) {
            finalPseudo = `${pseudo}_${Math.floor(Math.random() * 90 + 10)}`;
        }

        game.players.push({
            id: socket.id,
            pseudo: finalPseudo,
            role: '',
            word: '',
            connected: true
        });

        socket.join(code);

        io.to(code).emit('updatePlayers', game.players);
        socket.emit('gameJoined', { code, players: game.players });
    });

    // --- CHAT ---
    socket.on('sendMessage', ({ code, pseudo, msg, targetChat }) => {
        if (games[code]) {
            io.to(code).emit('receiveMessage', { pseudo, msg, targetChat });
        }
    });

    // --- START GAME ---
    socket.on('startGame', ({ code, settings, dictionnaireMots }) => {
        const game = games[code];
        if (!game || game.hostId !== socket.id) return;

        const listeFiltree = dictionnaireMots.filter(
            m => m.coche && (settings.filtreType === "all" || m.type === settings.filtreType)
        );

        if (!listeFiltree.length) {
            return socket.emit('errorMsg', "Aucun mot sélectionné !");
        }

        const paire = listeFiltree[Math.floor(Math.random() * listeFiltree.length)];
        game.currentWordPair = paire;
        game.started = true;
        game.votes = {};

        let nbImposteurs = parseInt(settings.nbImposteurs) || 1;
        nbImposteurs = Math.min(nbImposteurs, game.players.length - 1);

        const shuffled = [...game.players].sort(() => Math.random() - 0.5);

        shuffled.forEach((p, i) => {
            const player = game.players.find(x => x.id === p.id);

            if (i < nbImposteurs) {
                player.role = "Imposteur";
                player.word = paire.imposteur;
            } else {
                player.role = "Innocent";
                player.word = paire.innocent;
            }
        });

        game.players.forEach(player => {
            io.to(player.id).emit('gameStarted', {
                role: player.role,
                word: player.word,
                nbImposteurs
            });
        });

        io.to(code).emit('updatePlayers', game.players);
    });

    // --- VOTES ---
    socket.on('castVote', ({ code, duJoueur, contre }) => {
        const game = games[code];
        if (!game || !game.started) return;

        game.votes[duJoueur] = contre;

        io.to(code).emit('receiveMessage', {
            pseudo: "Système",
            msg: `🗳️ ${duJoueur} a voté !`,
            targetChat: "game-chat"
        });

        const actifs = game.players.filter(p => p.connected);

        if (Object.keys(game.votes).length >= actifs.length) {

            const count = {};
            let max = 0;
            let elimine = null;
            let egalite = false;

            Object.values(game.votes).forEach(v => {
                count[v] = (count[v] || 0) + 1;

                if (count[v] > max) {
                    max = count[v];
                    elimine = v;
                    egalite = false;
                } else if (count[v] === max) {
                    egalite = true;
                }
            });

            let text = "ÉGALITÉ !";
            const target = game.players.find(p => p.pseudo === elimine);

            if (!egalite && target) {
                text = target.role === "Imposteur"
                    ? `VICTOIRE INNOCENTS 😇 (${elimine} était imposteur)`
                    : `VICTOIRE IMPOSTEURS 🕵️ (${elimine} innocent)`;
            }

            game.started = false;

            io.to(code).emit('gameOver', {
                winnerText: text,
                allRoles: game.players
            });
        }
    });

    // --- RETURN LOBBY ---
    socket.on('requestLobbyReturn', (code) => {
        const game = games[code];
        if (!game) return;

        game.players.forEach(p => {
            p.role = '';
            p.word = '';
        });

        game.votes = {};
        game.started = false;

        io.to(code).emit('backToLobby', game.players);
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        for (const code in games) {
            const game = games[code];
            const index = game.players.findIndex(p => p.id === socket.id);

            if (index !== -1) {
                const player = game.players[index];

                if (!game.started) {
                    game.players.splice(index, 1);
                } else {
                    player.connected = false;
                }

                if (game.players.filter(p => p.connected).length === 0) {
                    delete games[code];
                } else {
                    if (game.hostId === socket.id) {
                        const newHost = game.players.find(p => p.connected);
                        if (newHost) game.hostId = newHost.id;
                    }

                    io.to(code).emit('updatePlayers', game.players);
                }
                break;
            }
        }

        console.log(`Déconnecté : ${socket.id}`);
    });
});

// 🚀 IMPORTANT POUR L’HÉBERGEMENT
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Serveur en ligne sur port ${PORT}`);
});