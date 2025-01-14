const { compare } = require('../modules/crypto');
const { classInformation, getClassIDFromCode } = require('../modules/class');
const { logNumbers } = require('../modules/config');
const { database } = require('../modules/database');
const { logger } = require('../modules/logger');
const { getUserClass } = require('../modules/user');
const jwt = require('jsonwebtoken');

function generateAccessToken(userData, classCode, refreshToken) {
    const token = jwt.sign({
        id: userData.id,
        username: userData.username,
        permissions: userData.permissions,
        classPermissions: userData.classPermissions,
        class: classCode,
        refreshToken
    }, userData.secret, { expiresIn: '30m' });

    return token;
};

function generateRefreshToken(userData) {
    const token = jwt.sign({
        id: userData.id,
        username: userData.username
    }, userData.secret, { expiresIn: '14d' });

    return token;
};

function storeRefreshToken(userId, refreshToken) {
    const decodedRefreshToken = jwt.decode(refreshToken)
    database.run('INSERT OR REPLACE INTO refresh_tokens (user_id, refresh_token, exp) VALUES (?, ?, ?)', [userId, refreshToken, decodedRefreshToken.exp], (err) => {
        if (err) throw err;
    });
};

module.exports = {
    run(app) {
        /* 
        This is what happens when the server tries to authenticate a user. 
        It saves the redirectURL query parameter to a variable, and sends the redirectURL to the oauth page.
        If a refresh token is provided, it will find the user associated with the token and generate a new access token.
        */
        app.get('/oauth', (req, res) => {
            try {
                const redirectURL = req.query.redirectURL;
                const refreshToken = req.query.refreshToken;

                logger.log('info', `[get /oauth] ip=(${req.ip}) session=(${JSON.stringify(req.session)})`);
                logger.log('verbose', `[get /oauth] redirectURL=(${redirectURL}) refreshToken=(${refreshToken})`);

                if (refreshToken) {
                    database.get('SELECT * FROM refresh_tokens WHERE refresh_token=?', [refreshToken], (err, refreshTokenData) => {
                        if (err) throw err;
                        if (!refreshTokenData) {
                            // Invalid refresh token
                            res.redirect(`/oauth?redirectURL=${redirectURL}`);
                            return;
                        };

                        database.get('SELECT * FROM users WHERE id=?', [refreshTokenData.user_id], (err, userData) => {
                            if (err) throw err;
                            if (userData) {
                                // Get class code and class permissions
                                const classCode = getUserClass(userData.username);
                                const classId = getClassIDFromCode(classCode);
                                userData.classPermissions = null;
                                if (classInformation.classrooms[classId] && classInformation.classrooms[classId].students[userData.username]) {
                                    userData.classPermissions = classInformation.classrooms[classId].students[userData.username].classPermissions;
                                }
                                
                                // Generate new access token
                                const accessToken = generateAccessToken(userData, classCode, refreshTokenData.refresh_token);
                                res.redirect(`${redirectURL}?token=${accessToken}`);
                            } else {
                                // Invalid user
                                res.redirect(`/oauth?redirectURL=${redirectURL}`);
                            };
                        });
                    });
                } else {
                    // Render the login page and pass the redirectURL
                    res.render('pages/login', {
                        title: 'Oauth',
                        redirectURL: redirectURL
                    });
                };          
            } catch (err) {
                logger.log('error', err.stack);
                res.render('pages/message', {
                    message: `Error Number ${logNumbers.error}: There was a server error try again.`,
                    title: 'Error'
                });
            };
        });

        // This is what happens after the user submits their authentication data.
        app.post('/oauth', (req, res) => {
            try {
                // It saves the username, password, and the redirectURL that is submitted.
                const { username, password, redirectURL } = req.body;

                logger.log('info', `[post /oauth] ip=(${req.ip}) session=(${JSON.stringify(req.session)})`);
                logger.log('verbose', `[post /oauth] username=(${username}) redirectURL=(${redirectURL})`);

                if (!username) {
                    res.render('pages/message', {
                        message: 'Please enter a username',
                        title: 'Login'
                    });
                    return;
                };

                if (!password) {
                    res.render('pages/message', {
                        message: 'Please enter a password',
                        title: 'Login'
                    });
                    return;
                };

                database.get('SELECT * FROM users WHERE username=?', [username], async (err, userData) => {
                    try {
                        if (err) throw err;

                        // Check if the user exists
                        if (!userData) {
                            logger.log('verbose', '[post /oauth] User does not exist')
                            res.render('pages/message', {
                                message: 'No user found with that username.',
                                title: 'Login'
                            });
                            return;
                        };

                        // Hashes users password
                        if (compare(JSON.parse(userData.password), password)) {
                            logger.log('verbose', '[post /oauth] Incorrect password')
                            res.render('pages/message', {
                                message: 'Incorrect password',
                                title: 'Login'
                            });
                            return;
                        };

                        // Get class code and class permissions
                        const classCode = getUserClass(userData.username)
                        const classId = await getClassIDFromCode(classCode)
                        userData.classPermissions = null
                        if (classInformation.classrooms[classId] && classInformation.classrooms[classId].students[userData.username]) {
                            userData.classPermissions = classInformation.classrooms[classId].students[userData.username].classPermissions;
                        }

                        // Retrieve or generate refresh token
                        database.get('SELECT * from refresh_tokens WHERE user_id=?', [userData.id], (err, refreshTokenData) => {
                            if (err) throw err;
                            
                            let refreshToken = null;
                            if (refreshTokenData) {
                                // Check if refresh token is past expiration date
                                const decodedRefreshToken = jwt.decode(refreshTokenData.refresh_token);
                                const currentTime = Math.floor(Date.now() / 1000);
                                if (decodedRefreshToken.exp < currentTime) {
                                    // Generate new refresh token
                                    refreshToken = generateRefreshToken(userData);
                                    storeRefreshToken(userData.id, refreshToken);
                                    return;
                                };

                                refreshToken = refreshTokenData.refresh_token;
                            } else {
                                refreshToken = generateRefreshToken(userData);
                                storeRefreshToken(userData.id, refreshToken);
                            };

                            // Generate access token
                            const accessToken = generateAccessToken(userData, classCode, refreshToken);
                                                
                            logger.log('verbose', '[post /oauth] Successfully Logged in with oauth');
                            res.redirect(`${redirectURL}?token=${accessToken}`);
                        });
                    } catch (err) {
                        logger.log('error', err.stack);
                        res.render('pages/message', {
                            message: `Error Number ${logNumbers.error}: There was a server error try again.`,
                            title: 'Error'
                        });
                    };
                });
            } catch (err) {
                logger.log('error', err.stack);
                res.render('pages/message', {
                    message: `Error Number ${logNumbers.error}: There was a server error try again.`,
                    title: 'Error'
                });
            };
        });
    }
};