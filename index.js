const express = require("express");
require("dotenv").config();
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
var admin = require("firebase-admin");
const { ObjectId } = require("mongodb");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));
const port = 3000;

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://ticket-point.vercel.app",
      "https://ticket-point.netlify.app",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());

const uri = process.env.DB_URI;

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("ticketPointDB");
    const usersCollection = db.collection("users");
    const ticketsCollection = db.collection("tickets");
    const bookingsCollection = db.collection("bookings");
    const transactionsCollection = db.collection("transactions");

    //role check middlewares
    const verifyRole = (requiredRole) => async (req, res, next) => {
      try {
        const user = await usersCollection.findOne({ email: req.tokenEmail });
        if (!user)
          return res.status(403).send({ message: "Forbidden: user not found" });
        if (user.role !== requiredRole)
          return res
            .status(403)
            .send({ message: `Forbidden: ${requiredRole} only` });
        req.currentUser = user;
        next();
      } catch (err) {
        next(err);
      }
    };

    const verifyAdmin = verifyRole("admin");
    const verifyVendor = verifyRole("vendor");

    // save or update a user in db
    app.post("/user", async (req, res) => {
      const userData = req.body;
      userData.created_at = new Date().toISOString();
      userData.last_loggedIn = new Date().toISOString();
      userData.role = "user";

      const query = {
        email: userData.email,
      };

      const alreadyExists = await usersCollection.findOne(query);
      console.log("User Already Exists---> ", !!alreadyExists);

      if (alreadyExists) {
        console.log("Updating user info......");
        const result = await usersCollection.updateOne(query, {
          $set: {
            last_loggedIn: new Date().toISOString(),
          },
        });
        return res.send(result);
      }

      console.log("Saving new user info......");
      const result = await usersCollection.insertOne(userData);
      res.send(result);
    });

    // get a user's role
    app.get("/user/role", verifyJWT, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail });
      res.send({ role: result?.role });
    });

    // get user
    app.get("/user/:email", verifyJWT, async (req, res) => {
      try {
        const email = req.params.email;
        const user = await usersCollection.findOne({ email: email });

        if (!user) {
          return res.status(404).send({ message: "User not found!" });
        }

        res.send(user);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // Vendor: add ticket
    app.post("/tickets", verifyJWT, verifyVendor, async (req, res) => {
      try {
        const ticket = req.body;

        const now = new Date().toISOString();
        ticket.vendor_name = req.currentUser.name || ticket.vendor_name;
        ticket.vendor_email = req.currentUser.email;
        ticket.created_at = now;
        ticket.status = "pending";
        ticket.advertised = false;
        ticket.hidden = !!req.currentUser.isFraud;
        const result = await ticketsCollection.insertOne(ticket);
        res.send(result);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Server error" });
      }
    });

    // get ticket by email
    app.get(
      "/tickets/vendor/:email",
      verifyJWT,
      verifyVendor,
      async (req, res) => {
        try {
          const email = req.params.email;
          const tickets = await ticketsCollection
            .find({
              vendor_email: email,
            })
            .toArray();

          if (!tickets) {
            return res.status(404).send({ message: "Ticket not found!" });
          }

          res.send(tickets);
        } catch (error) {
          console.error(error);
          res.status(500).send({ message: "Server error" });
        }
      }
    );

    // Delete ticket
    app.delete("/tickets/:id", verifyJWT, verifyVendor, async (req, res) => {
      const { id } = req.params;
      console.log(id);

      try {
        const result = await ticketsCollection.deleteOne({
          _id: new ObjectId(id),
        });
        if (result.deletedCount === 0) {
          return res.status(404).json({ message: "Ticket not found" });
        }
        res.json({
          message: "Ticket deleted successfully",
          deletedCount: result.deletedCount,
        });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    // Update ticket
    app.put("/tickets/:id", verifyJWT, verifyVendor, async (req, res) => {
      const id = req.params.id;
      const body = req.body;

      const result = await ticketsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: body }
      );

      res.send(result);
    });

    // get ticket by id
    app.get("/tickets/:id", verifyJWT, async (req, res) => {
      try {
        const id = req.params.id;
        const result = await ticketsCollection.findOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (err) {
        console.log(err);
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    // GET latest 6 tickets
    app.get("/latest-ticket", async (req, res) => {
      try {
        const tickets = await ticketsCollection
          .find({})
          .sort({ created_at: -1 })
          .limit(6)
          .toArray();

        res.status(200).json(tickets);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Failed to fetch latest tickets" });
      }
    });

    //save booked ticket
    app.post("/booked-tickets", verifyJWT, async (req, res) => {
      const { ticketId, user_email, user_name, quantity } = req.body;

      const ticket = await ticketsCollection.findOne({
        _id: new ObjectId(ticketId),
      });

      if (!ticket) return res.status(404).send({ message: "Ticket not found" });

      if (ticket.quantity < quantity) {
        return res
          .status(400)
          .send({ message: "Not enough tickets available" });
      }

      // create booking with ticket snapshot
      const booking = {
        ticketId: ticket._id,
        user_email,
        user_name,
        bookedQuantity: quantity,
        status: "pending",
        created_At: new Date(),

        // snapshot
        title: ticket.title,
        image: ticket.image,
        from: ticket.from,
        to: ticket.to,
        departure: ticket.departure,
        price: ticket.price,
        vendor_email: ticket.vendor_email,
      };

      // save booking
      await bookingsCollection.insertOne(booking);

      // decrease ticket quantity
      await ticketsCollection.updateOne(
        { _id: ticket._id },
        { $inc: { quantity: -quantity } }
      );

      res.send({ message: "Booking created", booking });
    });

    // GET all booked tickets for a user
    app.get("/booked-tickets/:email", verifyJWT, async (req, res) => {
      try {
        const email = req.params.email;

        const bookings = await bookingsCollection
          .find({ user_email: email })
          .toArray();

        res.status(200).json(bookings);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Failed to fetch booked tickets" });
      }
    });

    // GET: Vendor Requested Bookings
    app.get("/vendor/bookings/:email", verifyJWT, async (req, res) => {
      const email = req.params.email;

      const result = await bookingsCollection
        .find({ vendor_email: email })
        .sort({ createdAt: -1 })
        .toArray();

      res.send(result);
    });

    // PATCH: Accept Booking
    app.patch("/bookings/accept/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;

      const result = await bookingsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "accepted" } }
      );

      res.send(result);
    });

    // PATCH: Reject Booking
    app.patch("/bookings/reject/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;

      const result = await bookingsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "rejected" } }
      );

      res.send(result);
    });

    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();
    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
