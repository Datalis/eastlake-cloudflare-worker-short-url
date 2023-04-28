import jwt from "@tsndr/cloudflare-worker-jwt";
import { parse } from "cookie";

const invalidPaths = [
  "shorten",
  "login",
  "del",
  "edit",
  "links",
  "admin",
  "dashboard",
  "settings",
];
async function handleLogin(request) {
  const { username, password } = await request.json();
  let response;

  // Implement your authentication logic here, for example:
  if (username === USERNAME && password === PASSWORD) {
    // Generate a JWT token
    const expireHour = 24;
    //REMEMBER TO MODIFY THIS
    console.log(`JWT_SECRET is: ${JWT_SECRET}`);
    const expireTime = Math.floor(Date.now() / 1000) + expireHour * (60 * 60);
    // Creating a token
    const token = await jwt.sign(
      {
        username: username,
        exp: expireTime,
      },
      JWT_SECRET
    );

    // Store the JWT token in the KV namespace
    await LINKS.put(`jwt:${username}`, token, {
      expirationTtl: 60 * 60 * expireHour,
    });

    // Return the JWT token to the client
    response = new Response(JSON.stringify({ token, exp: expireTime }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } else {
    response = new Response("Invalid credentials", { status: 401 });
  }
  enableCORS(response);
  return response;
}

function generateRandomKey(length) {
  const characters =
    "23456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"; // exclude similar looking characters, include uppercase letters
  let result = "";
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

async function getCookie(request) {
  const { jwt } = await request.json();
  return jwt || "";
}

function generateUniqueKey() {
  const timestamp = Date.now();
  const randomString = Math.random().toString(36).substring(2, 12);
  return `${timestamp}${randomString}`;
}

async function handleShortenRequest(request) {
  // Get the parameters from the request
  const params = await request.json();
  const token = params.jwt;
  console.log(`token is:${token}`);
  const isValid = await jwt.verify(token, JWT_SECRET);
  if (!isValid) {
    return new Response("Invalid credentials! Need Login", { status: 401 });
  }
  const length = params.shortUrlLength;
  let response;

  let key;
  const url = params.shortUrl;

  if (url === null || url === "") {
    console.log("url is empty");
    key = generateRandomKey(length);
    let value = await LINKS.get(key);
    while (value !== null) {
      key = generateRandomKey(length);
      value = await LINKS.get(key);
    }
    key = `url:${key}`;
  } else {
    console.log("url is not empty");

    // Check if the path is already in use
    if (invalidPaths.includes(url)) {
      response = new Response("Invalid path because of conflict!", {
        status: 400,
      });
      enableCORS(response);
      return response;
    }
    key = `url:${url}`;
    const value = await LINKS.get(key);
    if (value !== null && JSON.parse(value).longUrl !== params.longUrl) {
      const response = new Response("The shortUrl has been used!", {
        status: 400,
      });
      enableCORS(response);
      return response;
    }
    const oldShortUrl = params.oldShortUrl;
    if (url !== oldShortUrl && value !== null) {
      const oldUrlKey = `url:${oldShortUrl}`;

      await LINKS.delete(oldUrlKey);
    }
  }

  // Store the parameters in KV
  const data = {
    expirationTime: params.expirationTime,
    requirePassword: params.requirePassword,
    password: params.password,
    shortUrlLength: length,
    longUrl: params.longUrl,
    id: params.id || generateUniqueKey(),
  };

  await LINKS.put(key, JSON.stringify(data));
  const result = {
    status: 200,
    shortUrl: key.split(":")[1],
    ...data,
  };
  response = new Response(JSON.stringify(result), { status: 200 });
  enableCORS(response);
  return response;
}

const CLICKS_NAMESPACE = "clicks";

function enableCORS(response) {
  // Add CORS headers
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE"
  );
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
}
async function storeClickRecord(
  shortUrl,
  timestamp,
  country,
  referrer,
  userAgent
) {
  const clickRecord = {
    timestamp: timestamp,
    country: country,
    referrer: referrer,
    userAgent: userAgent,
  };
  await LINKS.put(
    CLICKS_NAMESPACE + ":" + shortUrl,
    JSON.stringify(clickRecord)
  );

  // Update daily key
  const dateStr = new Date(timestamp * 1000).toISOString().slice(0, 10);
  await updateAggregateClickRecord(dateStr, shortUrl, clickRecord);

  // Update monthly key
  const monthStr = new Date(timestamp * 1000).toISOString().slice(0, 7);
  await updateAggregateClickRecord(monthStr, shortUrl, clickRecord);

  // Update yearly key
  const yearStr = new Date(timestamp * 1000).toISOString().slice(0, 4);
  await updateAggregateClickRecord(yearStr, shortUrl, clickRecord);
}

async function updateAggregateClickRecord(dateStr, shortUrl, clickRecord) {
  const aggregateKey = CLICKS_NAMESPACE + ":" + dateStr;
  const value = await LINKS.get(aggregateKey);
  if (value) {
    const aggregateRecord = JSON.parse(value);
    if (aggregateRecord[shortUrl]) {
      aggregateRecord[shortUrl].count += 1;
      aggregateRecord[shortUrl].clicks.push(clickRecord);
    } else {
      aggregateRecord[shortUrl] = {
        count: 1,
        clicks: [clickRecord],
      };
    }
    await LINKS.put(aggregateKey, JSON.stringify(aggregateRecord));
  } else {
    const aggregateRecord = {};
    aggregateRecord[shortUrl] = {
      count: 1,
      clicks: [clickRecord],
    };
    await LINKS.put(aggregateKey, JSON.stringify(aggregateRecord));
  }
}

async function getClickRecords(shortUrl) {
  const value = await LINKS.get(CLICKS_NAMESPACE + shortUrl);
  if (value === null) {
    return [];
  } else {
    return JSON.parse(value);
  }
}
async function addClickRecord(shortUrl, timestamp) {
  const date = new Date(timestamp);
  const dayKey = `${shortUrl}:${date.getUTCFullYear()}-${
    date.getUTCMonth() + 1
  }-${date.getUTCDate()}`;
  const monthKey = `${shortUrl}:${date.getUTCFullYear()}-${
    date.getUTCMonth() + 1
  }`;
  const yearKey = `${shortUrl}:${date.getUTCFullYear()}`;

  const dayValue = await LINKS.get(CLICKS_NAMESPACE + dayKey);
  const dayRecords = dayValue === null ? [] : JSON.parse(dayValue);
  dayRecords.push(timestamp);
  await LINKS.put(CLICKS_NAMESPACE + dayKey, JSON.stringify(dayRecords), {});

  const monthValue = await LINKS.get(CLICKS_NAMESPACE + monthKey);
  const monthRecords = monthValue === null ? [] : JSON.parse(monthValue);
  monthRecords.push(timestamp);
  await LINKS.put(
    CLICKS_NAMESPACE + monthKey,
    JSON.stringify(monthRecords),
    {}
  );

  const yearValue = await LINKS.get(CLICKS_NAMESPACE + yearKey);
  const yearRecords = yearValue === null ? [] : JSON.parse(yearValue);
  yearRecords.push(timestamp);
  await LINKS.put(CLICKS_NAMESPACE + yearKey, JSON.stringify(yearRecords), {});
}

export async function handleRequest(event) {
  const request = event.request;
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path || path === "/api/login") {
    return handleLogin(request);
  } else if (path === "/api/shorten") {
    return handleShortenRequest(request);
  } else if (path === "/api/del") {
    return handleDeleteRequest(request);
  } else if (path === "/api/list") {
    return handleListRequest(request);
  } else if (path === "/api/edit") {
    return handleEditRequest(request);
  } else {
    if (path == "/") {
      console.log("special redirect");
    }
    // Redirect the user to the full URL
    const pathWithoutSlash = path.substring(1);
    const key = `url:${pathWithoutSlash}`;
    console.log(`path is:${key}`);
    let fullURLObj = await LINKS.get(key);
    let response;
    console.log(`path is:${JSON.stringify(fullURLObj)}`);

    if (fullURLObj) {
      fullURLObj = JSON.parse(fullURLObj);
      if (fullURLObj.requirePassword) {
        // check if password is required
        if (params.password && params.password === fullURLObj.password) {
          // check if provided password matches
          response = Response.redirect(fullURLObj.longUrl, 302);
          event.waitUntil(addClickRecord(path, timestamp)); // Schedule click event recording in the background
        } else {
          response = new Response(
            "Please enter the password to access the URL",
            { status: 401 }
          ); // Unauthorized
          response.headers.append(
            "WWW-Authenticate",
            'Basic realm="Restricted Area"'
          ); // Add WWW-Authenticate header to prompt for password
        }
      } else {
        console.log(`fullURLObj.longUrl is:${fullURLObj.longUrl}`);
        response = Response.redirect(fullURLObj.longUrl, 302);
        // event.waitUntil(addClickRecord(path, timestamp)); // Schedule click event recording in the background
      }
    } else {
      response = new Response("NOT FOUND!", { status: 404 });
    }
    return response;
  }

  async function handleEditRequest(request) {
    const token = await getCookie(request);
    const isValid = await jwt.verify(token, JWT_SECRET);
    if (!isValid) {
      return new Response("Invalid credentials! Need Login", { status: 401 });
    }
    const params = await request.json();
    const {
      shortUrl,
      longUrl,
      expirationTime,
      requirePassword,
      password,
      shortUrlLength,
    } = params;
    let response;
    if (invalidPaths.include(shortUrl)) {
      response = new Response("Invalid path because of conflict!", {
        status: 400,
      });
      enableCORS(response);
      return response;
    }
    const value = await LINKS.get(shortUrl);
    if (value !== null) {
      response = new Response(`Short URL ${shortUrl} already exists!`, {
        status: 400,
      });
      enableCORS(response);
      return response;
    }

    // Update the record in KV
    const data = {
      expirationTime: expirationTime,
      requirePassword: requirePassword,
      password: password,
      shortUrlLength: shortUrlLength,
      longUrl: longUrl,
    };
    await LINKS.put(shortUrl, JSON.stringify(data));

    response = new Response(shortUrl, { status: 200 });
    enableCORS(response);
    return response;
  }

  async function handleDeleteRequest(request) {
    const token = await getCookie(request);
    const isValid = await jwt.verify(token, JWT_SECRET);
    if (!isValid) {
      return new Response("Invalid credentials! Need Login", { status: 401 });
    }
    const params = await request.json();
    const { shortUrl } = params;
    await LINKS.delete(shortUrl);
    const response = new Response(shortUrl, { status: 200 });
    enableCORS(response);
    return response;
  }

  async function handleListRequest(request) {
    const token = await getCookie(request);
    console.log(`token is ${token}`);
    const isValid = await jwt.verify(token, JWT_SECRET);
    if (!isValid) {
      return new Response("Invalid credentials! Need Login", { status: 401 });
    }

    const keys = await LINKS.list();
    const shortUrls = [];

    for (const key of keys.keys) {
      if (key.name.startsWith("url:")) {
        const value = await LINKS.get(key.name);
        if (value) {
          const data = JSON.parse(value);
          shortUrls.push({
            shortUrl: key.name,
            longUrl: data.longUrl,
            expirationTime: data.expirationTime,
            requirePassword: data.requirePassword,
          });
        }
      }
    }

    const response = new Response(JSON.stringify(shortUrls), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    enableCORS(response);
    return response;
  }
}