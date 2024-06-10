const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const express = require('express');
const { addDays, addMinutes, isAfter, parseISO } = require('date-fns');
const app = express();
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const port = process.env.port || 5000;

//middleware
const corsOptions = {
  origin: ['http://localhost:5173', 'https://story-flow-2024.netlify.app', 'https://storyflow-85a15.web.app',
    'https://storyflow-85a15.firebaseapp.com'
  ],
  credentials: true,
  optionSuccessStatus: 200,
}
app.use(cors(corsOptions));
app.use(express.json());


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster1.bhtyeej.mongodb.net/?retryWrites=true&w=majority&appName=Cluster1`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();

    const userCollection = client.db('storyFlow').collection('users');
    const publishersCollection = client.db('storyFlow').collection('publishers');
    const articlesCollection = client.db('storyFlow').collection('articles');


    //jwt related api
    app.post('/jwt', async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: '1h'
      })
      res.send({ token })
    })

    //middlewares
    const verifyToken = (req, res, next) => {
      console.log('inside verify token', req.headers.authorization);
      if (!req.headers.authorization) {
        return res.status(401).send({ message: 'unauthorized access ' })
      }
      const token = req.headers.authorization.split(' ')[1];
      jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) {
          return res.status(401).send({ message: 'unauthorized access' })
        }
        req.decoded = decoded;
        next();
      })
    }
//use verify  admin after verify token
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email
      const query = { email: email }
      const user = await userCollection.findOne(query);
      const isAdmin = user?.role === 'admin';
      if (!isAdmin) {
        return res.status(403).send({ message: 'forbidden access' })
      }
      next()
    }




    //payment intent
    app.post('/create-payment-intent',verifyToken, async (req, res) => {
      const { price } = req.body;
      const amount = parseInt(price * 100);
      // console.log('amount in side intentt',amount );

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: 'usd',
        payment_method_types: ['card']
      })

      res.send({
        clientSecret: paymentIntent.client_secret
      })
    })


    app.post('/users', async (req, res) => {
      try {
        const user = req.body;
        // console.log(user);

        const query = { email: user.email };
        const existingUser = await userCollection.findOne(query);
        if (existingUser) {
          return res.send({ message: 'User already exists', insertedId: null });
        }

        const result = await userCollection.insertOne(user);
        res.send(result);
      } catch (error) {
        console.error('Error inserting user:', error);
        res.status(500).send({ message: 'Internal Server Error', error });
      }
    });

    //get user from database
    app.get('/users', verifyToken,verifyAdmin, async (req, res) => {
      const result = await userCollection.find().toArray()
      res.send(result);
    })

    //make admin 
    app.patch('/users/admin/:id', verifyToken,verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) }
      const updatedDoc = {
        $set: {
          role: 'admin'
        }
      }


      const result = await userCollection.updateOne(filter, updatedDoc);
      res.send(result);

    })

    //delete user
    app.delete('/users/:id',verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const result = await userCollection.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 1) {
          res.send({ message: 'User deleted successfully', deletedCount: 1 });
        } else {
          res.status(404).send({ message: 'User not found', deletedCount: 0 });
        }
      } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).send({ message: 'Internal Server Error', error });
      }
    });

    //search admin by email
    app.get('/users/admin/:email', verifyToken,verifyAdmin, async (req, res) => {
      const email = req.params.email;

      if (email !== req.decoded.email) {
        return res.status(403).send({ message: 'forbidden access' })
      }

      const query = { email: email };
      const user = await userCollection.findOne(query);
      let admin = false;
      if (user) {
        admin = user?.role === 'admin';

      }
      res.send({ admin })

    })

    //get the  uer by id
    app.get('/users/:id',verifyToken,verifyAdmin, async (req, res) => {

      const id = req.params.id;

      try {
        const user = await userCollection.findOne({ _id: new ObjectId(id) });
        res.status(200).send(user);
      } catch (err) {
        res.status(500).send({ error: 'Error fetching user data', details: err });
      }
    });

    //update user after taken premium 
    app.put('/users/:email/premium',verifyToken,verifyAdmin, async (req, res) => {
      const { email } = req.params;
      // console.log(email);
      const { premiumTaken } = req.body;

      try {
        const result = await userCollection.updateOne({ email: email }, { $set: { premiumTaken: premiumTaken } });
        if (result.modifiedCount > 0) {
          res.status(200).send({ message: 'User premium status updated' });
        } else {
          res.status(404).send({ message: 'User not found or premium status not updated' });
        }
      } catch (err) {
        res.status(500).send({ error: 'Error updating user premium status', details: err });
      }
    });

    //compare login time
    app.post('/login',verifyToken, async (req, res) => {
      const { email } = req.body;

      try {
        const user = await userCollection.findOne({ email: email });
        if (user) {
          const currentDate = new Date();
          const premiumExpiryDate = addMinutes(new Date(user.premiumTaken), 1);
          if (user.premiumTaken && isAfter(currentDate, premiumExpiryDate)) {
            await userCollection.updateOne(
              { email: email },
              { $set: { premiumTaken: null } }
            );
            user.premiumTaken = null;
          }
          res.status(200).send(user);
        } else {
          res.status(404).send({ message: 'User not found' });
        }
      } catch (err) {
        res.status(500).send({ error: 'Error logging in user', details: err });
      }
    });


    //post publisher
    app.post('/publishers',verifyToken,verifyAdmin, async (req, res) => {
      try {
        const publisher = req.body;
        // console.log(user);

        const result = await publishersCollection.insertOne(publisher);
        res.send(result);

      } catch (error) {
        console.error('Error inserting user:', error);
        res.status(500).send({ message: 'Internal Server Error', error });
      }
    });

    //get publisher
    app.get('/publishers',verifyToken, async (req, res) => {

      const result = await publishersCollection.find().toArray()
      res.send(result);
    })

    // Check if user can add an article
    app.get('/can-add-article/:email',verifyToken, async (req, res) => {
      try {
        const email = req.params.email;

        const user = await userCollection.findOne({ email: email });

        if (user.premiumTaken && user.premiumTaken !== 'null') {

          res.send({ allowed: true });
        } else {

          const articles = await articlesCollection.find({ authorEmail: email }).toArray();

          if (articles.length > 0) {

            res.send({ allowed: false });
          } else {

            res.send({ allowed: true });
          }
        }
      } catch (error) {
        console.error('Error checking user:', error);
        res.status(500).send({ message: 'Internal Server Error', error });
      }
    });

    //post article
    app.post('/articles',verifyToken, async (req, res) => {
      try {
        const article = req.body;
        article.postedDate = new Date();
        // console.log(article);

        const result = await articlesCollection.insertOne(article);
        res.send(result);

      } catch (error) {
        console.error('Error inserting user:', error);
        res.status(500).send({ message: 'Internal Server Error', error });
      }
    });

    //get all articles
    app.get('/articles',verifyToken,verifyAdmin, async (req, res) => {
      const result = await articlesCollection.find().toArray()
      res.send(result);

    })

    //update article status
    app.patch('/articles/:id/status',verifyToken,verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        const result = await articlesCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: status } }
        );

        res.send(result);
      } catch (error) {
        console.error('Error updating article status:', error);
        res.status(500).send({ message: 'Internal Server Error', error });
      }
    });

    // update premium

    app.patch('/articles/:id/premium',verifyToken,verifyAdmin, async (req, res) => {
      const { id } = req.params;
      const { isPremium } = req.body;
      try {
        const result = await articlesCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { isPremium: isPremium } }
        );
        res.send(result);
      } catch (error) {
        console.error('Error updating article premium status:', error);
        res.status(500).send({ message: 'Internal Server Error', error });
      }
    });



    //delete article 


    app.delete('/articles/:id',verifyToken,verifyAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const result = await articlesCollection.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 1) {
          res.send({ message: 'Article deleted successfully', deletedCount: 1 });
        } else {
          res.status(404).send({ message: 'Article not found', deletedCount: 0 });
        }
      } catch (error) {
        console.error('Error deleting article:', error);
        res.status(500).send({ message: 'Internal Server Error', error });
      }
    });


    //decline status and add declined reason
    app.patch('/articles/:id/declinedStatus',verifyToken,verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const { status, declinedReason } = req.body;
        console.log(req.body);
        const filter = { _id: new ObjectId(id) };
        const updateDoc = { $set: { status } };
        if (status === 'declined') {
          updateDoc.$set.declinedReason = declinedReason;
        }
        const result = await articlesCollection.updateOne(filter, updateDoc);
        res.send(result);
      } catch (error) {
        console.error('Error updating article status:', error);
        res.status(500).send({ message: 'Internal Server Error', error });
      }
    });




    //articles get by status
    app.get('/articles/status/:status',verifyToken, async (req, res) => {
      try {
        const { status } = req.params;
        const articles = await articlesCollection.find({ status }).toArray();
        res.send(articles);
      } catch (error) {
        console.error('Error fetching articles by status:', error);
        res.status(500).send({ message: 'Internal Server Error', error });
      }
    });


    // get  to search articles by title
    app.get('/articles/search/:title', async (req, res) => {
      try {
        const { title } = req.params;
        const query = { title: { $regex: title, $options: 'i' } };
        const articles = await articlesCollection.find(query).toArray();
        res.send(articles);
      } catch (error) {
        console.error('Error searching articles by title:', error);
        res.status(500).send({ message: 'Internal Server Error', error });
      }
    });

    //filetr by publisher

    app.get('/articles/publisher/:publisher',verifyToken, async (req, res) => {
      try {
        const { publisher } = req.params;
        const articles = await articlesCollection.find({ publisher }).toArray();
        res.send(articles);
      } catch (error) {
        console.error('Error filtering articles by publisher:', error);
        res.status(500).send({ message: 'Internal Server Error', error });
      }
    });

    // // Filter articles by publisher and tags
    app.get('/articles/filter', async (req, res) => {
      try {
        const { publisher, tags } = req.query;
        let query = {};
        if (publisher) {
          query.publisher = publisher;
        }
        if (tags) {
          query.tags = { $in: tags.split(",") }; // Assuming tags are stored as an array in your database
        }
        const articles = await articlesCollection.find(query).toArray();
        res.send(articles);
      } catch (error) {
        console.error('Error filtering articles:', error);
        res.status(500).send({ message: 'Internal Server Error', error });
      }
    });



    //get article by id
    app.get('/articles/:id',verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const article = await articlesCollection.findOne({ _id: new ObjectId(id) });

        if (!article) {
          return res.status(404).send({ message: 'Article not found' });
        }
        res.send(article);
      } catch (error) {
        console.error('Error fetching article:', error);
        res.status(500).send({ message: 'Internal Server Error', error });
      }
    });

    //update by view count
    app.patch('/articles/:id/view',verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const result = await articlesCollection.updateOne(
          { _id: new ObjectId(id) },
          { $inc: { views: 1 } }
        );
        if (result.matchedCount === 0) {
          return res.status(404).send({ message: 'Article not found' });
        }
        res.send({ message: 'View count incremented' });
      } catch (error) {
        console.error('Error incrementing view count:', error);
        res.status(500).send({ message: 'Internal Server Error', error });
      }
    });







    //article get by user email

    app.get('/articles/user/:email',verifyToken, async (req, res) => {
      try {
        const email = req.params.email;
        const query = { authorEmail: email };

        const result = await articlesCollection.find(query).toArray();
        res.send(result);
      } catch (error) {
        console.error('Error fetching articles by user email:', error);
        res.status(500).send({ message: 'Internal Server Error', error });
      }
    });

    //update article 
    app.patch('/articles/:id/update',verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const updatedArticle = req.body;
        // const options = { upsert: true };
        // console.log(updatedArticle);
        const article = {
          $set: {
            title: updatedArticle.title,
            description: updatedArticle.description,
            publisher: updatedArticle.publisher,
            tags: updatedArticle.tags,
            image: updatedArticle.image,
            updatedAt: new Date()
          }
        };

        const result = await articlesCollection.updateOne(filter, article);
        if (result.matchedCount === 0) {
          return res.status(404).send({ message: 'Article not found' });
        }
        res.send({ message: 'Article updated successfully', result });
      } catch (error) {
        console.error('Error updating article:', error);
        res.status(500).send({ message: 'Internal Server Error', error });
      }
    });

    //get by premium
    app.get('/articles/premium/:isPremium',verifyToken, async (req, res) => {
      try {
        const { isPremium } = req.params;
        const query = { isPremium };
        const articles = await articlesCollection.find(query).toArray();
        res.send(articles);
      } catch (error) {
        console.error('Error fetching articles by isPremium:', error);
        res.status(500).send({ message: 'Internal Server Error', error });
      }
    });

    //get by sorting view counts
    app.get('/trending-articles', async (req, res) => {
      try {
        const articles = await articlesCollection.find({ status: 'approved' })
          .sort({ views: -1 })
          .limit(6)
          .toArray();
        res.status(200).json(articles);
      } catch (error) {
        console.error('Error fetching trending articles:', error);
        res.status(500).send({ message: 'Internal Server Error', error });
      }
    });


    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);




app.get('/', (req, res) => {
  res.send('Salam from stroy flow server')
})

app.listen(port, () => {
  console.log(`Story Flow is running on port ${port}`);
})