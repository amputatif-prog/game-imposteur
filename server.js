const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const games = {};
const pseudosRigolos = ["NoobMaster", "PikaSel", "ChefGlitch", "LagKing", "RatioMan", "BotDocile", "TeemoFan", "CamperPro", "SpawnKill"];

function genererPseudoDrole(game) {
    let base;
    do { base = pseudosRigolos[Math.floor(Math.random() * pseudosRigolos.length)]; } 
    while (game && game.players.some(p => p.pseudo === base));
    return base;
}

io.on('connection', (socket) => {
    console.log(`Joueur connecté : ${socket.id}`);

    // --- CRÉER PARTIE (OPTIONS LIÉES AUX RÉGLAGES DU MENU) ---
    socket.on('createGame', ({ pseudo, icone, settings, dictionnaireMots }) => {
        let code;
        do { code = Math.random().toString(36).substring(2, 6).toUpperCase(); } while (games[code]);

        let finalPseudo = pseudo.trim().substring(0, 10);
        if(!finalPseudo) finalPseudo = genererPseudoDrole(null);

        games[code] = {
            hostId: socket.id,
            players: [{ id: socket.id, pseudo: finalPseudo, icone: icone || "🎮", role: '', word: '', connected: true }],
            votes: {},
            started: false,
            currentWordPair: null,
            settings: settings,
            dictionnaireMotsCache: dictionnaireMots
        };

        socket.join(code);
        socket.emit('gameCreated', { code, assignedPseudo: finalPseudo, players: games[code].players, settings: games[code].settings });
    });

    // --- REJOINDRE PARTIE ---
    socket.on('joinGame', ({ code, pseudo, icone }) => {
        const game = games[code];
        if (!game) return socket.emit('errorMsg', "Code incorrect !");
        if (game.started) return socket.emit('errorMsg', "Partie déjà lancée !");

        let finalPseudo = pseudo.trim().substring(0, 10);
        if (!finalPseudo) {
            finalPseudo = genererPseudoDrole(game);
        } else {
            const exists = game.players.some(p => p.pseudo.toLowerCase() === finalPseudo.toLowerCase());
            if (exists) { finalPseudo = `${finalPseudo.substring(0,7)}_${Math.floor(Math.random() * 90 + 10)}`; }
        }

        game.players.push({ id: socket.id, pseudo: finalPseudo, icone: icone || "🎮", role: '', word: '', connected: true });
        socket.join(code);
        
        io.to(code).emit('updatePlayers', { hostId: game.hostId, players: game.players });
        socket.emit('gameJoined', { code, assignedPseudo: finalPseudo, players: game.players, settings: game.settings });
    });

    socket.on('sendMessage', ({ code, pseudo, msg, targetChat }) => {
        if (games[code]) { io.to(code).emit('receiveMessage', { pseudo, msg, targetChat }); }
    });

    // --- ENCLENCHEMENT DE LA GAME ---
    socket.on('startGame', ({ code }) => {
        const game = games[code];
        if (!game || game.hostId !== socket.id) return;

        const dictionnaire = game.dictionnaireMotsCache;
        const listeFiltree = dictionnaire.filter(m => m.coche && 
            (game.settings.filtreType === "all" || m.type === game.settings.filtreType) &&
            (game.settings.filtreDiff === "all" || m.difficulte === game.settings.filtreDiff)
        );

        if (!listeFiltree.length) return socket.emit('errorMsg', "Aucun mot sélectionné !");

        const paire = listeFiltree[Math.floor(Math.random() * listeFiltree.length)];
        game.currentWordPair = paire;
        game.started = true;
        game.votes = {};

        let nbImposteurs = parseInt(game.settings.nbImposteurs) || 1;
        nbImposteurs = Math.min(nbImposteurs, game.players.length);

        const shuffled = [...game.players].sort(() => Math.random() - 0.5);
        shuffled.forEach((p, i) => {
            const player = game.players.find(x => x.id === p.id);
            if (i < nbImposteurs) { player.role = "Imposteur"; player.word = paire.imposteur; } 
            else { player.role = "Innocent"; player.word = paire.innocent; }
        });

        game.players.forEach(player => {
            io.to(player.id).emit('gameStarted', {
                role: player.role,
                word: player.word,
                nbImposteurs,
                roleVisibility: game.settings.roleVisibility
            });
        });

        io.to(code).emit('updatePlayers', { hostId: game.hostId, players: game.players });
    });

    // --- COMPTAGE DES VOTES ---
    socket.on('castVote', ({ code, duJoueur, contre }) => {
        const game = games[code];
        if (!game || !game.started) return;

        game.votes[duJoueur] = contre;

        let messageVote = `🗳️ ${duJoueur} a validé son choix !`;
        if (game.settings.voteDisclosure === "detailed") {
            messageVote = `🗳️ ${duJoueur} a voté contre 👉 ${contre} !`;
        }

        io.to(code).emit('receiveMessage', { pseudo: "Système", msg: messageVote, targetChat: "game-chat" });
        const actifs = game.players.filter(p => p.connected);

        if (Object.keys(game.votes).length >= actifs.length) {
            const count = {}; let max = 0; let elimine = null; let egalite = false;

            Object.values(game.votes).forEach(v => {
                count[v] = (count[v] || 0) + 1;
                if (count[v] > max) { max = count[v]; elimine = v; egalite = false; } 
                else if (count[v] === max) { egalite = true; }
            });

            let text = "🚨 ÉGALITÉ ! L'imposteur s'en sort indemne !";
            const target = game.players.find(p => p.pseudo === elimine);

            if (!egalite && target) {
                text = target.role === "Imposteur"
                    ? `😇 VICTOIRE DES INNOCENTS ! Vous avez éjecté l'Imposteur ${elimine}.`
                    : `🕵️ VICTOIRE DES IMPOSTEURS ! Vous avez sacrifié l'innocent ${elimine}.`;
            }

            game.started = false;
            io.to(code).emit('gameOver', { winnerText: text, allRoles: game.players });
        }
    });

    socket.on('requestLobbyReturn', (code) => {
        const game = games[code];
        if (!game) return;
        game.players.forEach(p => { p.role = ''; p.word = ''; });
        game.votes = {}; game.started = false;
        io.to(code).emit('backToLobby', { hostId: game.hostId, players: game.players });
    });

    socket.on('disconnect', () => {
        for (const code in games) {
            const game = games[code];
            const index = game.players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                if (!game.started) { game.players.splice(index, 1); } else { game.players[index].connected = false; }
                if (game.players.filter(p => p.connected).length === 0) { delete games[code]; } 
                else {
                    if (game.hostId === socket.id) {
                        const newHost = game.players.find(p => p.connected);
                        if (newHost) game.hostId = newHost.id;
                    }
                    io.to(code).emit('updatePlayers', { hostId: game.hostId, players: game.players });
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log(`Serveur actif sur port ${PORT}`); });