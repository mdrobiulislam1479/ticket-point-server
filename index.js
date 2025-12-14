require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
var admin = require("firebase-admin");
const { ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPR_DECRET_KEY);

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
    const paymentsCollection = db.collection("payments");

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
      userData.isFraud = false;

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
        ticket.price = Number(ticket.price);
        ticket.quantity = Number(ticket.quantity);
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
          .find({
            status: "approved",
          })
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
        paymentStatus: "unpaid",
        created_At: new Date().toISOString(),

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
      const bookingId = req.params.id;

      // 1. Find booking
      const booking = await bookingsCollection.findOne({
        _id: new ObjectId(bookingId),
      });

      if (!booking) {
        return res.status(404).send({ message: "Booking not found" });
      }

      // 2. Update booking status
      const bookingResult = await bookingsCollection.updateOne(
        { _id: new ObjectId(bookingId) },
        { $set: { status: "rejected" } }
      );

      // 3. Increase ticket quantity
      await ticketsCollection.updateOne(
        { _id: new ObjectId(booking.ticketId) },
        { $inc: { quantity: booking.bookedQuantity } }
      );

      res.send({
        success: true,
        bookingResult,
      });
    });

    //Checkout Session
    app.post("/create-checkout-session", verifyJWT, async (req, res) => {
      const { ticket, user } = req.body;

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],

        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: ticket.title },
              unit_amount: ticket.price * 100,
            },
            quantity: ticket.bookedQuantity,
          },
        ],

        success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_URL}/dashboard/my-bookings`,

        metadata: {
          bookingId: ticket.bookingId,
          userEmail: user.email,
          vendorEmail: ticket.vendorEmail,
          ticketTitle: ticket.title,
        },
      });

      res.send({ url: session.url });
    });

    //Save Payment History
    app.post("/payment-success", async (req, res) => {
      const { sessionId } = req.body;

      const session = await stripe.checkout.sessions.retrieve(sessionId);

      if (session.payment_status !== "paid") {
        return res.status(400).send({ message: "Payment not completed" });
      }

      // prevent duplicate
      const exists = await paymentsCollection.findOne({
        stripeSessionId: session.id,
      });

      if (exists) {
        return res.send({ message: "Already recorded" });
      }

      const paymentData = {
        bookingId: new ObjectId(session.metadata.bookingId),
        userEmail: session.metadata.userEmail,
        vendorEmail: session.metadata.vendorEmail,
        ticketTitle: session.metadata.ticketTitle,
        amount: session.amount_total / 100,
        stripeSessionId: session.id,
        transactionId: session.payment_intent,
        status: "paid",
        paidAt: new Date(),
      };

      await paymentsCollection.insertOne(paymentData);

      await bookingsCollection.updateOne(
        { _id: new ObjectId(session.metadata.bookingId) },
        { $set: { paymentStatus: "paid", paidAt: new Date().toISOString() } }
      );

      res.send({ success: true });
    });

    // get all transactions
    app.get("/transactions/:email", verifyJWT, async (req, res) => {
      try {
        const email = req.params.email;

        const transactions = await paymentsCollection
          .find({ userEmail: email })
          .sort({ paidAt: -1 })
          .toArray();

        res.send(transactions);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to fetch transactions" });
      }
    });

    // Get all tickets (Admin)
    app.get("/admin/tickets", verifyJWT, verifyAdmin, async (req, res) => {
      const result = await ticketsCollection.find().toArray();
      res.send(result);
    });

    // Approve Ticket
    app.patch(
      "/admin/tickets/approve/:id",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;

        const result = await ticketsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: "approved",
              approvedAt: new Date(),
            },
          }
        );

        res.send(result);
      }
    );

    // Reject Ticket
    app.patch(
      "/admin/tickets/reject/:id",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;

        const result = await ticketsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: "rejected",
              rejectedAt: new Date(),
            },
          }
        );

        res.send(result);
      }
    );

    // Get all users
    app.get("/admin/users", verifyJWT, verifyAdmin, async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    });

    // Make Admin
    app.patch(
      "/admin/users/make-admin/:id",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { role: "admin" } }
        );
        res.send(result);
      }
    );

    // Make Vendor
    app.patch(
      "/admin/users/make-vendor/:id",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { role: "vendor", isFraud: false } }
        );
        res.send(result);
      }
    );

    // Mark Vendor as Fraud
    app.patch(
      "/admin/users/mark-fraud/:id",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        const user = await usersCollection.findOne({
          _id: new ObjectId(req.params.id),
        });

        if (user.role !== "vendor") {
          return res.status(400).send({ message: "Not a vendor" });
        }

        // Mark vendor fraud
        await usersCollection.updateOne(
          { _id: user._id },
          { $set: { isFraud: true } }
        );

        // Hide all vendor tickets
        await ticketsCollection.updateMany(
          { vendor_email: user.email },
          { $set: { status: "hidden" } }
        );

        res.send({ success: true });
      }
    );

    // Get all approved tickets (Admin)
    app.get(
      "/admin/advertise-tickets",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        const tickets = await ticketsCollection
          .find({
            status: "approved",
          })
          .toArray();

        res.send(tickets);
      }
    );

    // Toggle Advertise / Unadvertise (Max 6 limit)
    app.patch(
      "/admin/tickets/advertise/:id",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;

        const ticket = await ticketsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!ticket) {
          return res.status(404).send({ message: "Ticket not found" });
        }

        // If advertising → check limit
        if (!ticket.advertised) {
          const advertisedCount = await ticketsCollection.countDocuments({
            advertised: true,
          });

          if (advertisedCount >= 6) {
            return res.status(400).send({
              message: "You can advertise a maximum of 6 tickets only",
            });
          }
        }

        const result = await ticketsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { advertised: !ticket.advertised } }
        );

        res.send(result);
      }
    );

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
