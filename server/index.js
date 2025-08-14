// Import the express package to create our web server.
import express from "express";
import path from "path";
import http from "http";
import { v4 as uuidv4 } from "uuid";

// We also import the increment value from the common code.
import State, { COLORS } from "../common/chess.js";

// This is how to import a specific item from a javascript module. Similar to
// `from x import y` in python.
import { Server } from "socket.io";
import Move from "../common/move.js";
import { readFile, writeFile } from "fs/promises";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The port that the web server runs on.
const PORT = process.env.PORT || 8080;

// This creates our web server. `const` declares a variable that cannot be reassigned.
const app = express();

// This tells express to send any files in the "dist" directory, which is where parcel
// outputs its page build files. Basically, if you ask for any file in the "client" directory
// this will make sure that the file is sent to the user.
app.get("/", (req, res) => {
    res.redirect("/login.html");
});
app.use(express.static("dist"));
app.use(express.static("client"));
app.use("/common", express.static(path.join(__dirname, "common")));


// This is a little complicated, but this allows us to send data to the server in
// JSON (JavaScript Object Notaton) to the server.
app.use(express.json());

let sessions = {};
let owners = {};

// `let` defines a locally-scoped variable that can be modified (not const). It is
// good to get into the habit of using `let` instead of `var` as `var` has some
// strange semantics:
// https://stackoverflow.com/questions/762011/what-is-the-difference-between-let-and-var

let state = State.default();
let stateSum = State.sum(state);

async function saveSessionsAndOwners() {
    await Promise.all([
        writeFile("save/sessions.json", JSON.stringify(sessions)),
        writeFile("save/owners.json", JSON.stringify(owners)),
    ]);
}

async function loadSessionsAndOwners() {
    await Promise.all([
        readFile("save/sessions.json")
            .then((f) => (sessions = JSON.parse(f)))
            .catch((e) => writeFile("save/sessions.json", "{}")),
        readFile("save/owners.json")
            .then((f) => (owners = JSON.parse(f)))
            .catch((e) => writeFile("save/owners.json", "{}")),
    ]);
}

async function loadGame() {
    await readFile("save/game.json")
        .then((f) => {
            state = State.deserialize(JSON.parse(f));
            stateSum = State.sum(state);
        })
        .catch((e) => writeFile("save/game.json", "{}"));
}

async function saveGame() {
    await writeFile("save/game.json", JSON.stringify(state.serialize()));
}

async function load() {
    await Promise.all([loadSessionsAndOwners(), loadGame()]);
}

async function save() {
    await Promise.all([saveSessionsAndOwners(), saveGame()]);
}

await load();

// Autosave interval
setInterval(async () => {
    console.log("autosaving...");
    await save();
}, 5 * 60 * 1000);

console.log("sessions and owners loaded!");

function createNewOwner(username, color) {
    const newId = uuidv4();
    const newSession = uuidv4();

    const owner = { username, color };
    owners[newId] = owner;
    sessions[newSession] = newId;

    state.createPiecesFor(newId);
    stateSum = State.sum(state);

    io.emit("state", {
        owners,
        state: state.serialize(),
        sum: stateSum,
    });


    saveSessionsAndOwners();
    return { session: newSession, owner: newId };
}

app.get("/me", (req, res) => {
    const { session } = req.query;
    if (session && sessions[session]) {
        return res
            .status(200)
            .json({ exists: true, owner: owners[sessions[session]] });
    } else {
        return res.status(200).json({ exists: false, owner: null });
    }
});

app.post("/new", (req, res) => {
    const { username, color } = req.body;

    if (
        username &&
        username.length < 16 &&
        username.length > 3 &&
        color &&
        COLORS.includes(color)
    ) {
        const { session, owner } = createNewOwner(username, color);
        return res.status(200).json({ success: true, session, owner });
    } else {
        return res.status(400).json({ success: false });
    }
});

const server = http.createServer(app);

// This creates our socket.io instance for websocket communication.
const io = new Server(server);

io.on("connection", (socket) => {
    const { session } = socket.handshake.query;

    if (!session || !sessions[session]) {
        socket.emit("error");
        socket.disconnect();
        return;
    }

    const owner = sessions[session];
    const ownerData = owners[owner];
    console.log(`${socket.id} connected! (owner=${owner}, username=${ownerData.username}, color=${ownerData.color})`);

    socket.emit("state", {
        owner,
        owners,
        state: state.serialize(),
        sum: stateSum,
    });

    socket.on("move", (data) => {
        // Client has gotten out of sync;
        if (stateSum !== data.sum) {
            socket.emit("state", {
                owner,
                owners,
                state: state.serialize(),
                sum: stateSum,
            });
            return;
        }
        const move = Move.deserialize(data.move);
        console.log(owner, "-", move.toString());
        // TODO: validate
        console.log(`State sum before: ${stateSum}`);
        state.makeMove(move);
        stateSum = State.sum(state);
        console.log(`State sum after: ${stateSum}`);

        io.emit("move", { move: move.serialize(), sum: stateSum });
    });
    socket.on("promote", ({ x, y, type }) => {
        //get the piece information
        const piece = state.pieceAt(x, y)
        if (piece && piece.getOwner() === owner) {
            const newPiece = piece.promoteTo(type)
            if (newPiece) {
                //update the piece on the backend side
                state.pieces.push(newPiece)
            }

            stateSum = State.sum(state);

            io.emit("state", {
                owner,
                owners,
                state: state.serialize(),
                sum: stateSum,
            });

            console.log(`Promoted (${x}, ${y}) to type ${type}`);
        }
    })

    socket.on("state_request", () => {
        socket.emit("state", {
            owner,
            owners,
            state: state.serialize(),
            sum: stateSum,
        });
    });
});

// This will have the server listen on the port provided at the top of the file.
server.listen(PORT, '0.0.0.0', () => {
    // This is a special javascript format string! Use the characters `` and insert
    // a ${} to have any variable concatenated into the string. It is similar to an
    // f-string in python.
    console.log(`Server started at: http://localhost:${PORT}`);
});

