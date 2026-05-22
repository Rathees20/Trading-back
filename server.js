import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import Stripe from "stripe";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

// Load configuration
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_monster_trading_key";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "monster123";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

// Initialize Stripe if key available
let stripe = null;
if (STRIPE_SECRET_KEY) {
    stripe = new Stripe(STRIPE_SECRET_KEY);
    console.log("Stripe initialized successfully.");
} else {
    console.warn("WARNING: STRIPE_SECRET_KEY environment variable is not defined!");
}

const app = express();

// Increase JSON size limits to support base64 image uploads in blogs
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(cors());

// File paths for persistence (fallback / seeding source)
const DATA_DIR = path.join(__dirname, "data");
const BLOGS_FILE = path.join(DATA_DIR, "blogs.json");
const INITIAL_BLOGS_FILE = path.join(DATA_DIR, "initialBlogs.json");

// MongoDB Connection URI
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
    console.error("CRITICAL ERROR: MONGODB_URI is not defined in the environment variables!");
    process.exit(1);
}

// Define Mongoose Schema for Blogs
const blogSchema = new mongoose.Schema({
    id: { type: Number, required: true, unique: true },
    title: { type: String, required: true },
    excerpt: { type: String, default: "" },
    category: { type: String, default: "Trend Engine" },
    author: { type: String, default: "Trading Monster Team" },
    date: { type: String },
    image: { type: String, default: "" },
    heroImage: { type: String, default: "" },
    videoUrl: { type: String, default: "" },
    contentVideo: { type: String, default: "" },
    content: { type: String, required: true },
    bottomContent: { type: String, default: "" },
    status: { type: String, default: "published" },
    isFeatured: { type: Boolean, default: false }
}, {
    timestamps: true
});

const Blog = mongoose.model("Blog", blogSchema);

// Connect to MongoDB and seed if empty
mongoose.connect(MONGODB_URI)
    .then(async () => {
        console.log("Connected to MongoDB successfully.");
        try {
            const count = await Blog.countDocuments();
            if (count === 0) {
                console.log("MongoDB collection is empty. Seeding initial data...");
                let initialData = [];
                if (fs.existsSync(BLOGS_FILE)) {
                    initialData = JSON.parse(fs.readFileSync(BLOGS_FILE, "utf-8"));
                } else if (fs.existsSync(INITIAL_BLOGS_FILE)) {
                    initialData = JSON.parse(fs.readFileSync(INITIAL_BLOGS_FILE, "utf-8"));
                }

                if (initialData.length > 0) {
                    await Blog.insertMany(initialData);
                    console.log(`Successfully seeded ${initialData.length} blogs into MongoDB.`);
                } else {
                    console.log("No initial blog data found to seed.");
                }
            }
        } catch (seedErr) {
            console.error("Error seeding MongoDB:", seedErr);
        }
    })
    .catch(err => {
        console.error("Failed to connect to MongoDB:", err);
    });

// Authentication Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
        return res.status(401).json({ error: "Access Denied: No Token Provided" });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: "Access Denied: Invalid or Expired Token" });
        }
        req.user = user;
        next();
    });
};

// Optional Authentication Check (doesn't fail if token is missing or invalid)
const optionalAuthenticateToken = (req, res, next) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
        req.user = null;
        return next();
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            req.user = null;
        } else {
            req.user = user;
        }
        next();
    });
};

/* ==========================================================================
   AUTHENTICATION ENDPOINTS
   ========================================================================== */

app.post("/api/login", (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: "Username and password are required" });
    }

    if (username.trim() === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        // Sign and return a JWT valid for 24h
        const token = jwt.sign({ username: ADMIN_USERNAME, role: "admin" }, JWT_SECRET, { expiresIn: "24h" });
        return res.json({ token, message: "Authentication successful!" });
    }

    return res.status(401).json({ error: "Invalid username or password" });
});

/* ==========================================================================
   BLOG ENDPOINTS (REST API)
   ========================================================================== */

// GET all blogs
app.get("/api/blogs", optionalAuthenticateToken, async (req, res) => {
    try {
        let query = {};
        // If not admin, exclude drafts
        if (!req.user || req.user.role !== "admin") {
            query.status = { $ne: "draft" };
        }
        
        // Find and sort descending by id
        const blogs = await Blog.find(query).sort({ id: -1 });
        return res.json(blogs);
    } catch (error) {
        console.error("Error fetching blogs:", error);
        return res.status(500).json({ error: "Failed to fetch articles from database." });
    }
});

// GET single blog by ID
app.get("/api/blogs/:id", optionalAuthenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const queryId = Number(id);
        const post = await Blog.findOne({ id: isNaN(queryId) ? id : queryId });

        if (!post) {
            return res.status(404).json({ error: "Article not found" });
        }

        // If it's a draft and visitor is not admin, deny access
        if (post.status === "draft") {
            if (!req.user || req.user.role !== "admin") {
                return res.status(403).json({ error: "Access Denied: This article is a draft" });
            }
        }

        return res.json(post);
    } catch (error) {
        console.error("Error fetching blog:", error);
        return res.status(500).json({ error: "Failed to fetch article details." });
    }
});

// POST create a new blog
app.post("/api/blogs", authenticateToken, async (req, res) => {
    try {
        const {
            title, excerpt, category, author, date,
            image, heroImage, videoUrl, contentVideo,
            content, bottomContent, status, isFeatured
        } = req.body;

        if (!title || !content) {
            return res.status(400).json({ error: "Title and content are required." });
        }

        // Get maximum id in collection to generate the next unique numeric ID
        const maxIdPost = await Blog.findOne().sort({ id: -1 });
        const newId = maxIdPost ? (Number(maxIdPost.id) || 0) + 1 : 1;

        const newPostData = {
            id: newId,
            title,
            excerpt: excerpt || "",
            category: category || "Trend Engine",
            author: author || "Trading Monster Team",
            date: date || new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "2-digit" }),
            image: image || "",
            heroImage: heroImage || image || "",
            videoUrl: videoUrl || "",
            contentVideo: contentVideo || videoUrl || "",
            content,
            bottomContent: bottomContent || "",
            status: status || "published",
            isFeatured: !!isFeatured
        };

        // Handle single-featured logic: if this post is featured, make all others non-featured
        if (newPostData.isFeatured) {
            await Blog.updateMany({ isFeatured: true }, { isFeatured: false });
        }

        const newPost = new Blog(newPostData);
        await newPost.save();

        return res.status(201).json(newPost);
    } catch (error) {
        console.error("Error creating blog:", error);
        return res.status(500).json({ error: "Failed to create article in database." });
    }
});

// PUT update a blog post
app.put("/api/blogs/:id", authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const {
            title, excerpt, category, author, date,
            image, heroImage, videoUrl, contentVideo,
            content, bottomContent, status, isFeatured
        } = req.body;

        const queryId = Number(id);
        const post = await Blog.findOne({ id: isNaN(queryId) ? id : queryId });

        if (!post) {
            return res.status(404).json({ error: "Article not found" });
        }

        // Update fields if provided in request
        if (title !== undefined) post.title = title;
        if (excerpt !== undefined) post.excerpt = excerpt;
        if (category !== undefined) post.category = category;
        if (author !== undefined) post.author = author;
        if (date !== undefined) post.date = date;
        if (image !== undefined) post.image = image;
        if (heroImage !== undefined) {
            post.heroImage = heroImage;
        } else if (image !== undefined) {
            post.heroImage = image;
        }
        if (videoUrl !== undefined) post.videoUrl = videoUrl;
        if (contentVideo !== undefined) {
            post.contentVideo = contentVideo;
        } else if (videoUrl !== undefined) {
            post.contentVideo = videoUrl;
        }
        if (content !== undefined) post.content = content;
        if (bottomContent !== undefined) post.bottomContent = bottomContent;
        if (status !== undefined) post.status = status;
        
        if (isFeatured !== undefined) {
            post.isFeatured = !!isFeatured;
        }

        // Handle single-featured logic: if this post is set to featured, make all others non-featured
        if (post.isFeatured) {
            await Blog.updateMany({ id: { $ne: post.id }, isFeatured: true }, { isFeatured: false });
        }

        await post.save();
        return res.json(post);
    } catch (error) {
        console.error("Error updating blog:", error);
        return res.status(500).json({ error: "Failed to update article in database." });
    }
});

// DELETE a blog post
app.delete("/api/blogs/:id", authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const queryId = Number(id);
        const result = await Blog.deleteOne({ id: isNaN(queryId) ? id : queryId });

        if (result.deletedCount === 0) {
            return res.status(404).json({ error: "Article not found" });
        }

        return res.json({ message: "Article deleted successfully", id });
    } catch (error) {
        console.error("Error deleting blog:", error);
        return res.status(500).json({ error: "Failed to delete article from database." });
    }
});

/* ==========================================================================
   STRIPE PAYMENT ENDPOINT
   ========================================================================== */

const calculateOrderAmount = (items) => {
    if (items && items[0] && items[0].amount) {
        return items[0].amount * 100; // Convert to cents
    }
    return 1400;
};

app.post("/create-payment-intent", async (req, res) => {
    console.log("Received payment intent request in unified backend:", req.body);
    const { items } = req.body;

    if (!stripe) {
        return res.status(500).json({ error: "Stripe is not configured on this server." });
    }

    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: calculateOrderAmount(items),
            currency: "usd",
            automatic_payment_methods: {
                enabled: true,
            },
        });

        res.send({
            clientSecret: paymentIntent.client_secret,
        });
    } catch (err) {
        console.error("Error creating payment intent:", err);
        res.status(500).json({ error: err.message });
    }
});

// Root check
app.get("/", (req, res) => {
    res.json({ message: "Trading Monster API is live!" });
});

// Start Server
app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(` Trading Monster server running on http://localhost:${PORT}`);
    console.log(`=========================================`);
});
