const path = require('path');
const open = require('open');
const express = require('express');
const axios = require('axios');
const pkce = require('pkce');
const qs = require('querystring');


/**
    System Config
*/

const client_id = 'c43fd49f237b4ce999032fd66350fe1c';
const port = 9754;
const redirect_uri = `http://localhost:${port}/cb`;
const scope = 'user-library-read user-library-modify';

const spotifyAuthURI = 'https://accounts.spotify.com/authorize';
const spotifyTokenURI = 'https://accounts.spotify.com/api/token';

const state = pkce.createChallenge(); // Too lazy to make my own random stuff
// Generate Code Verifier and Code Challenge
const codePair = pkce.create();

const albumsPerRequest = 50;

let server,
  accessToken,
  tokenType,
  expiresIn,
  refreshToken,
  refreshTokenTimeoutID;


/**
    Express Functions
*/

// Start HTTP server
const app = express();

app.get('/cb', (req, res) => {
  const authState = req.query.state;
  const authCode = req.query.code;
  const authError = req.query.error;

  if (state !== authState || typeof authError !== 'undefined') {
    sendPublicFile(res, 'error.html');
    shutdown();
  } else {
    const reqData = {
      client_id: client_id,
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: redirect_uri,
      code_verifier: codePair.codeVerifier,
    };

    return requestNewAccessToken(reqData)
      .then((resData) => {
        if (resData.status === 200) {
          sendPublicFile(res, 'success.html');
          return tokenHandler(resData);
        } else {
          sendPublicFile(res, 'error.html');
          throw 'Error requesting access token.';
        }
      }).catch((error) => {
        console.log(`Error "${error}" when processing callback!`);
        shutdown();
      });
  }
});

// Send file response to requester
function sendPublicFile(res, filename) {
  res.sendFile(path.join(__dirname, 'public', filename));
}


/**
    API Functions
*/

async function getLibraryAlbums() {
  return axios.get('https://api.spotify.com/v1/me/albums', {
    headers: {
      Authorization: `${tokenType} ${accessToken}`,
    },
    params: {
      limit: albumsPerRequest,
    },
  }).then((response) => {
    const resData = response.data;

    return {
      remaining: resData.total,
      ids: resData.items.map((item) => item.album.id),
    };
  }).catch((error) => {
    console.log(`Error "${error}" when retrieving library album list from api!`);
  });
}

async function deleteLibraryAlbums(ids) {
  return axios.delete('https://api.spotify.com/v1/me/albums', {
    headers: {
      Authorization: `${tokenType} ${accessToken}`,
    },
    data: {
      ids,
    },
  }).catch((error) => {
    console.log(`Error "${error}" when deleting library albums!`);
  });
}


/**
    Auth Functions
*/

// Generate the initial authorization URI
function generateAuthURI() {
  const response_type = 'code';
  const code_challenge_method = 'S256';
  const code_challenge = codePair.codeChallenge;

  const authURI = spotifyAuthURI + '?' +
    `client_id=${client_id}&` +
    `response_type=${response_type}&` +
    `redirect_uri=${redirect_uri}&` +
    `code_challenge_method=${code_challenge_method}&` +
    `code_challenge=${code_challenge}&` +
    `state=${state}&` +
    `scope=${scope}`;

  return authURI;
}

async function requestNewAccessToken(reqData) {
  return axios.post(spotifyTokenURI, qs.stringify(reqData))
    .then((response) => {
      if (response.status === 200) {
        let { access_token, token_type, scope, expires_in, refresh_token } = response.data;

        return {
          status: response.status,
          access_token: access_token,
          token_type: token_type,
          expires_in: expires_in,
          refresh_token: refresh_token,
        };
      } else {
        return {
          status: response.status,
        };
      }
    });
}

async function tokenHandler(data) {
  console.log('Authorization successful.');
  accessToken = data.access_token;
  tokenType = data.token_type;
  expiresIn = data.expires_in;
  refreshToken = data.refresh_token;

  setupRefreshTimeout();

  let numAlbums, numDeleted;

  do {
    try {
      const albumData = await getLibraryAlbums();
      numAlbums = albumData.remaining;
      numDeleted = albumData.ids.length;

      if (numAlbums > 0) {
        await deleteLibraryAlbums(albumData.ids);
      }
    } catch (error) {
      console.log('Error in token handler!');
      throw error;
    }
  } while (numAlbums > 0 && numDeleted === albumsPerRequest);

  shutdown();
}


/**
    Timer/Interval Functions
*/

function setupRefreshTimeout() {
  // Timer for refreshing access token 10 seconds before it expires
  clearTimeout(refreshTokenTimeoutID);

  refreshTokenTimeoutID = setTimeout(() => {
    const reqData = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client_id,
    };

    return requestNewAccessToken(reqData)
      .then((resData) => {
        if (resData.status === 200) {
          accessToken = resData.access_token;
          tokenType = resData.token_type;
          expiresIn = resData.expires_in;
          refreshToken = resData.refresh_token;


          // Start another timeout so we can refresh again later
          setupRefreshTimeout();
        } else {
          throw resData.status;
        }
      }).catch((error) => {
        console.log(`Error ${error} when retrieving access token!`);
        shutdown();
      });
  }, (expiresIn - 10) * 1000);
}


/**
    Utility Functions
*/

function shutdown() {
  console.log('Completed!');
  console.log('Shutting down...');

  clearTimeout(refreshTokenTimeoutID);

  if (typeof server !== 'undefined') {
    server.close(() => {
      process.exit();
    });
  }
}

// Open browser tab with URI
async function openURI(uri) {
  // Open URI with browser to get user auth tokens
  await open(uri, {
    url: true,
  });
}


/**
    Start Here
*/

async function init() {
  server = app.listen(port, () => {
    console.log('Please authorize this application to access your Spotify library data.');
  });

  return openURI(generateAuthURI());
}

init();