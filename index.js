const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const axios = require('axios');
const admin = require('firebase-admin');
require('dotenv').config();
const tokenAbi = require('./abi/token.json')
const serviceAccount = require('./firebase-service-account.json');
const { initializeAndExecute } = require('./swap.js');
// Initialize Firebase Admin SDK
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://mudasbot-default-rtdb.firebaseio.com/"
});
const db = admin.firestore();

const bot = new TelegramBot('8020592770:AAGe3kB0t3jmmtdwLeK_VXBZhZaaDWe7y7c', { polling: true });

// Connect to Metis Andromeda RPC endpoint
const provider = new ethers.providers.JsonRpcProvider("https://andromeda.metis.io/?owner=1088");

// Main menu buttons setup with emojis
const mainMenuButtons = {
    reply_markup: {
        inline_keyboard: [
            // Line 1: Buy / Sell & Manage
            [{ text: "💸 Buy", callback_data: "buy" }, { text: "📈 Sell", callback_data: "sell" }],

            // Line 2: Current Wallet / Wallet Manager
            [{ text: "💼 Current Wallet", callback_data: "current_wallet" }, { text: "🔧 Wallet Manager", callback_data: "wallet_manager" }],

            // Line 3: Backup Bots / Refer Friends / Staking
            [{ text: "🤖 Backup Bot", callback_data: "backup" }, { text: "👫 Referrals", callback_data: "referral" }, { text: "🔥 Staking", callback_data: "staking" }],

            // Line 4: Set Pin / Refresh / Settings
            [{ text: "🔐 Set PIN", callback_data: "set_pin" }, { text: "🔄 Refresh", callback_data: "refresh" }, { text: "⚙️ Settings", callback_data: "settings" }],
            [{ text: "Help desk", url: "https://medusa-3.gitbook.io/medusa-trading-bot/" }]
        ]
    }
};
async function checkPinInDatabase(username) {
    const userRef = db.collection('users').doc(username);
    const doc = await userRef.get();

    return doc.exists && doc.data()?.pin ? true : false;
}

async function handleSettingsMenu(username) {
    const pinExists = await checkPinInDatabase(username); // Check if the PIN exists for the given username
    console.log(pinExists)
    const settingsMenu = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🔄 Adjust Slippage", callback_data: "slippage" }],
                [{ text: "🔄 Adjust Gas Fee", callback_data: "gasFee" }],
                ...(!pinExists ? [] : [[{ text: "Delete PIN", callback_data: "delete_pin" }]]),
                [{ text: "🔔 Toggle Notifications", callback_data: "notifications" }],
                [{ text: "🔍 View Private Key", callback_data: "view_private_key" }],
                [{ text: "⬅️ Back to Main Menu", callback_data: "main_menu" }]
            ]
        }
    };

    return settingsMenu;
}
async function getTokenDetails(tokenAddress) {
    try {
        // CoinGecko API endpoint for getting token details (use the token's contract address or token symbol)
        const url = `https://api.coingecko.com/api/v3/coins/metis-andromeda/contract/0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000/`;

        // Fetch token details from CoinGecko
        const response = await axios.get(url);

        // Extracting the relevant data from the response
        const data = response.data;
        return data
    } catch (error) {
        console.error('Error fetching token details from CoinGecko:', error);
        // throw new Error('Could not fetch token details');
    }
}
function calculatePriceChange(prices) {
    if (prices && prices.length > 1) {
        const startPrice = prices[0][1];
        const endPrice = prices[prices.length - 1][1];
        return ((endPrice - startPrice) / startPrice) * 100;
    }
    return 0;
}
// Helper function to get or create a wallet in Firebase
async function getOrCreateWallet(username, privateKey = null) {
    const walletRef = db.collection('wallets').doc(username);
    const doc = await walletRef.get();

    if (doc.exists) {
        const { address } = doc.data();
        return new ethers.Wallet(privateKey, provider);
    }

    const wallet = privateKey ? new ethers.Wallet(privateKey, provider) : ethers.Wallet.createRandom().connect(provider);
    await walletRef.set({ address: wallet.address });
    return wallet;
}
async function sendNativeCurrency(privateKey, toAddress, amount) {
    const wallet = new ethers.Wallet(privateKey, provider);
    const amountInWei = ethers.utils.parseEther(amount.toString());

    try {
        // Get current gas price and multiply it by the gas multiplier (e.g., 1.1 for 10% higher)
        const gasPrice = await provider.getGasPrice();
        const adjustedGasPrice = gasPrice.mul(110).div(100); // 10% higher than current gas price

        // Estimate gas limit for the transaction
        const estimatedGas = await provider.estimateGas({
            to: toAddress,
            value: amountInWei
        });
        
        // Add 20% buffer to estimated gas
        const gasLimit = estimatedGas.mul(120).div(100);

        // Send native transaction with specified gas parameters
        const tx = await wallet.sendTransaction({
            to: toAddress,
            value: amountInWei,
            gasPrice: adjustedGasPrice,
            gasLimit: gasLimit
        });

        await tx.wait(); // Wait for the transaction to be mined

        // Calculate gas cost in METIS
        const gasCost = adjustedGasPrice.mul(tx.gasLimit);
        const gasCostInMetis = ethers.utils.formatEther(gasCost);

        return {
            success: true,
            hash: tx.hash,
            gasCost: gasCostInMetis,
            message: `✔️ Transaction successful!\nTx Hash: ${tx.hash}\nGas Cost: ${gasCostInMetis} METIS`
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            message: `❌ Error sending transaction: ${error.message}`
        };
    }
}

async function setPin(username, pin) {
    const userRef = db.collection('users').doc(username);
    await userRef.set({ pin: pin }, { merge: true });
}

async function getPin(username) {
    const userRef = db.collection('users').doc(username);
    const doc = await userRef.get();
    return doc.exists ? doc.data().pin : null;
}


// Start command: Initialize or import wallet
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username || `user_${chatId}`;
    const wallet = await getOrCreateWallet(username);
    const storedPin = await getPin(username);  // Check if a PIN is set

    // If a PIN is set, prompt the user to enter it
    if (storedPin) {
        bot.sendMessage(chatId, "🔐 Please enter your 4-digit PIN for secure access:");

        bot.once("message", (pinMsg) => {
            const enteredPin = pinMsg.text.trim();

            if (enteredPin === storedPin) {
                // If PIN is correct, show the main menu
                bot.sendPhoto(chatId, 'https://ibb.co/Rz50tsz', {
                  
                    caption: `<b>🔱 $MEDUSA Trading Bot 🔱</b>
<b>The Fastest Bot for trading on #Metis Andromeda Blockchain!</b>

<b>How to Get Started:</b>
 1️⃣ <b>Deposit $METIS</b>: Go to "Current Wallet" and add funds.  

 2️⃣ <b>Buy Tokens</b>: Input the token address or paste a URL.  

 3️⃣ <b>Sell & Manage</b>: Set sell orders and monitor your portfolio.  

 4️⃣ <b>Customize Settings</b>: Adjust slippage and enable notifications.  

 5️⃣ <b>Secure Your Wallet</b>: Set a PIN for added protection. 
                                 
<b>Ready to trade? </b>Start now on the Metis Chain!
📖 <a href="https://t.me/Medusa_Metis">Guide</a> | 🔗 <a href="https://explorer.metis.io">Explorer</a> | ➕ <a href="https://chainlist.org/chain/1088">Add RPC</a>

🔱 <b>Stay Connected: </b>
🌐 <a href="https://www.medusametis.io">Website</a> | 🐦 <a href="https://x.com/medusa_metis">X/Twitter</a> | 💬 <a href="https://t.me/Medusa_Metis">Telegram</a>  
                   `,


                    reply_markup: mainMenuButtons.reply_markup,
                    parse_mode: 'HTML'
                });

            } else {
                bot.sendMessage(chatId, "❌ Incorrect PIN. Please try /start again and enter the correct PIN.");
            }
        });
    } else {
        // If no PIN is set, show the welcome message directly
        bot.sendPhoto(chatId, 'https://ibb.co/Rz50tsz', {
            
            caption: `<b>🔱 $MEDUSA Trading Bot 🔱</b>
 <b>The Fastest Bot for trading on #Metis Andromeda Blockchain!</b>

<b>How to Get Started:</b>
 1️⃣ <b>Deposit $METIS</b>: Go to "Current Wallet" and add funds.  

 2️⃣ <b>Buy Tokens</b>: Input the token address or paste a URL.  

 3️⃣ <b>Sell & Manage</b>: Set sell orders and monitor your portfolio.  

 4️⃣ <b>Customize Settings</b>: Adjust slippage and enable notifications.  

 5️⃣ <b>Secure Your Wallet</b>: Set a PIN for added protection. 

<b>Ready to trade? </b>Start now on the Metis Chain!
📖 <a href="https://t.me/Medusa_Metis">Guide</a> | 🔗 <a href="https://explorer.metis.io">Explorer</a> | ➕ <a href="https://chainlist.org/chain/1088">Add RPC</a>

🔱 <b>Stay Connected: </b>
🌐 <a href="https://www.medusametis.io">Website</a> | 🐦 <a href="https://x.com/medusa_metis">X/Twitter</a> | 💬 <a href="https://t.me/Medusa_Metis">Telegram</a>  
`,
            reply_markup: mainMenuButtons.reply_markup,
            parse_mode: 'HTML'
        });

    }
});

async function handleReferral(chatId) {
    const referralLink = `https://t.me/MedusaTrading_bot?start=${chatId}`;
    bot.sendMessage(chatId, 
        `Invite your friends using this 👉 <a href="${referralLink}">link</a>👈\nEarn points for every friend who joins<b> —you and your friends all win!</b>`,
        {parse_mode: 'HTML'}
    );
}


// Handle callbacks for main menu and wallet actions
bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const username = query.from.username || `user_${chatId}`;

    if (query.data === "wallet_manager") {
        bot.sendMessage(chatId, "<b>🔧 Wallet Manager</b>:\nChoose an option to manage your wallet:", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🆕 Create Wallet", callback_data: "create_wallet" }],
                    [{ text: "🔑 Import Wallet", callback_data: "import_wallet" }],
                    [{ text: "⬅️ Send Metis", callback_data: "sent_token" }],
                    [{ text: "🔍 View Wallet Balance", callback_data: "balance" }],
                    [{ text: "⬅️ Back to Main Menu", callback_data: "main_menu" }]
                ]
            },
            parse_mode: 'HTML'
        });
    } else if (query.data === "create_wallet") {
        const wallet = await getOrCreateWallet(username);
        bot.sendMessage(chatId, `🎉 Wallet created successfully!\n\n💼 Address: <a href="https://explorer.metis.io/address/${wallet.address}">${wallet.address}</a>\n\nChoose an action:`, {
            reply_markup: mainMenuButtons.reply_markup,
            parse_mode: 'HTML'
        });
    } else if (query.data === "import_wallet") {
        bot.sendMessage(chatId, "🔑 Please send your private key to import your wallet.");

        bot.once("message", async (msg) => {
            const privateKey = msg.text.trim();
            try {
                const wallet = await getOrCreateWallet(username, privateKey);
                bot.sendMessage(chatId, `🎉 Wallet created successfully!\n\n💼 Address: <a href="https://explorer.metis.io/address/${wallet.address}">${wallet.address}</a>\n\nChoose an action:`, {
                    reply_markup: mainMenuButtons.reply_markup,
                    parse_mode: 'HTML'
                });
            } catch (error) {
                bot.sendMessage(chatId, `❌ Error importing wallet: ${error.message}`);
            }
        });
    }
    else if (query.data === "sent_token") {
        const wallet = await getOrCreateWallet(username);
        const balance = await provider.getBalance(wallet.address);
        const balanceInEther = ethers.utils.formatEther(balance);
        bot.sendMessage(chatId, `📬 <b>Enter the recipient's address</b>

<b>⚠️ Warning</b> Only send METIS to addresses or CEXs that support the Andromeda blockchain. We are NOT responsible for funds lost if sent elsewhere.

<b>📜 Disclaimer:</b> Ensure the address is correct—we are NOT liable for any loss of funds sent to unsupported addresses.

<b>🔹Metis Balance:</b> ${balanceInEther} METIS
`, {

            parse_mode: "HTML"
        });
        bot.once("message", async (msg) => {
            const toAddress = msg.text.trim();
            bot.sendMessage(chatId, "💰 How many Metis tokens would you like to send?");

            // Wait for the user to send the amount
            bot.once("message", async (msg) => {
                const wallet = await getOrCreateWallet(username);
                //    console.log(wallet.privateKey)
                // bot.sendMessage(chatId, wallet.privateKey);
                const amount = msg.text.trim();
                try {

                    const privateKey = wallet.privateKey;

                    const result = await sendNativeCurrency(privateKey, toAddress, amount);
                    bot.sendMessage(chatId, '🎉 Congratulations!!. Your transaction was successful');
                } catch (error) {
                    bot.sendMessage(chatId, `❌ Something Went Wrong`);
                }
            });
        });

    }
    else if (query.data === "set_pin") {
        bot.sendMessage(chatId, "<b>🔐 Set a 4-digit PIN</b> for secure access:",{
              parse_mode: 'HTML'
        });
        bot.once("message", async (msg) => {
            const pin = msg.text.trim();
            if (/^\d{4}$/.test(pin)) {
                await setPin(username, pin);
                bot.sendMessage(chatId, "✔️ PIN set successfully!", {
                    reply_markup: mainMenuButtons.reply_markup
                });
            } else {
                bot.sendMessage(chatId, "❌ Invalid PIN. Please enter a 4-digit number.");
            }
        });
    }
    else if (query.data === "gasFee") {
        bot.sendMessage(chatId, "<b>🛠 Enter the gas fee</b> (a positive number):", {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "Normal (1.5)", callback_data: "gas_1.5" },
                        { text: "Fast (2.0)", callback_data: "gas_2.0" }
                    ],
                    [
                        { text: "Turbo (2.5)", callback_data: "gas_2.5" },
                        { text: "Custom", callback_data: "gas_custom" }
                    ],
                    [{ text: "⬅️ Back", callback_data: "settings" }]
                ]
            }
        });
    } 
    else if (query.data.startsWith("gas_")) {
        const value = query.data.split("_")[1];
        
        if (value === "custom") {
            bot.sendMessage(chatId, "🛠 <b>Enter your custom gas fee</b> (positive number):", {
                parse_mode: 'HTML'
            });
            bot.once("message", async (msg) => {
                const gasFee = msg.text.trim();
                if (/^\d+(\.\d+)?$/.test(gasFee) && parseFloat(gasFee) > 0) {
                    bot.sendMessage(chatId, `✔️ Gas fee set successfully to ${gasFee}!`, {
                        reply_markup: mainMenuButtons.reply_markup
                    });
                } else {
                    bot.sendMessage(chatId, "❌ Invalid input. Please enter a valid positive number.");
                }
            });
        } else {
            const gasFee = parseFloat(value);
            bot.sendMessage(chatId, `✔️ Gas fee set successfully to ${gasFee}!`, {
                reply_markup: mainMenuButtons.reply_markup
            });
        }
    }
    else if (query.data === "balance") {
        const wallet = await getOrCreateWallet(username);
        try {
            const balance = await provider.getBalance(wallet.address);
            bot.sendMessage(chatId, `💰 Your balance is: ${ethers.utils.formatEther(balance)} METIS`);
        } catch (error) {
            bot.sendMessage(chatId, `❌ Error fetching balance: ${error.message}`);
        }
    }
    else if (query.data === "backup") {
        const wallet = await getOrCreateWallet(username);
        const privateKey = wallet.privateKey;
        if (privateKey) {
            // Create a text file with the private key
            const fs = require('fs');
            const filePath = './private_key.txt'; // File path for the temporary text file

            fs.writeFileSync(filePath, `Private Key: ${privateKey}`);

            // Send the text file to the user
            bot.sendDocument(chatId, filePath, {}, { caption: 'Here is your backup private key file.' })
                .then(() => {
                    // Optionally, delete the file after sending it
                    fs.unlinkSync(filePath);
                })
                .catch(err => {
                    console.error('Error sending document:', err);
                    bot.sendMessage(chatId, 'Sorry, there was an issue with sending the backup file.');
                });
        } else {
            bot.sendMessage(chatId, 'Sorry, I could not find your private key.');
        }
    }
    else if (query.data === "view_private_key") {
        const wallet = await getOrCreateWallet(username);
        bot.sendMessage(chatId, `<b>🔑 Your Private Key</b>(keep it safe!):\n\n${wallet.privateKey}`,{
              parse_mode: 'HTML'
        });
    }
    else if (query.data === "settings") {
        const settingsMenu = await handleSettingsMenu(username);
        bot.sendMessage(chatId, "⚙️ <b>Settings</b>:\n• Adjust Slippage\n• Adjust Gas Fee\n• Toggle Notifications\n• View Private Keys\n• Back to Main Menu", {
            reply_markup: settingsMenu.reply_markup,
            parse_mode: 'HTML'
        });
    }
    else if (query.data === "current_wallet") {
        try {
            const wallet = await getOrCreateWallet(username);
            const balance = await provider.getBalance(wallet.address);

            // Convert balance from Wei to Ether for readability
            const balanceInEther = ethers.utils.formatEther(balance);

            bot.sendMessage(chatId, `<b>💼 Your wallet address is:</b> \n <a href="https://explorer.metis.io/address/${wallet.address}">${wallet.address}</a> \n <b>🔹Metis Balance:</b> ${balanceInEther} METIS`, {
                parse_mode: "HTML"
            })
        } catch (error) {
            bot.sendMessage(chatId, `❌ Error retrieving wallet: ${error.message}`);
        }
    }
    else if (query.data === "referral") {
        try {
            await handleReferral(chatId);
        } catch (error) {
            bot.sendMessage(chatId, `❌ Error retrieving wallet: ${error.message}`);
        }
    }
    else if (query.data === "buy") {
        try {
            // Step 1: Ask for the token address
            await bot.sendMessage(chatId, "<b>Enter the Token Address (Metis Chain)</b> for the token you want to swap to.", {parse_mode: 'HTML'} );

            // Step 2: Listen for the token address
            bot.once('message', async (tokenAddressMessage) => {
                const tokenAddress = tokenAddressMessage.text;
                const wallet = await getOrCreateWallet(username);
                const balance = await provider.getBalance(wallet.address);

                // Convert balance from Wei to Ether for readability
                const balanceInEther = ethers.utils.formatEther(balance);

                // Inform the user about their balance and prompt for the amount
                await bot.sendMessage(
                    chatId,
                    `<b>Your current balance is:</b> ${balanceInEther} METIS.\nPlease enter the amount in METIS that you want to swap (e.g., 0.1):`, {
                    parse_mode: 'HTML'
                }

                );

                // Step 3: Ask for the amount


                // Step 4: Listen for the amount
                bot.once('message', async (amountMessage) => {
                    const amountInEther = amountMessage.text;

                    // Step 5: Ask for the private key
                    const wallet = await getOrCreateWallet(username);
                    // console.log(wallet.privateKey)
                    const privateKey = wallet.privateKey;

                    try {
                        // Convert amount to Wei
                        const amountInWei = ethers.utils.parseUnits(amountInEther, "ether");

                        // Set tokenIn and tokenOut addresses
                        const tokenIn = '0x75cb093E4D61d2A2e65D8e0BBb01DE8d89b53481'; // Replace with actual tokenIn address if different
                        const tokenOut = tokenAddress;

                        // Define recipient address and slippage tolerance
                        const recipient = wallet.address;// Replace with actual address or user ID
                        const slippageTolerance = 0.02; // 2% slippage tolerance

                        // Step 7: Call the initializeAndExecute function with all the required parameters
                        const receipt = await initializeAndExecute(privateKey, amountInWei, tokenIn, tokenOut, recipient, slippageTolerance);
                        const tokenDetails = await getTokenDetails(tokenOut);
                  
const successMessage = `
<b>🔱 Position Management 🔱</b>
———————————
🔗 CA: ${tokenOut}
———————————
🪙 Token: <a href="https://coinmarketcap.com/currencies/metisdao">${tokenDetails.name}</a>
💥 Status: ${tokenDetails.market_data.price_change_24h}% Change
💵 Price: $${tokenDetails.market_data.current_price.usd || 'N/A'} | Market Cap: $${tokenDetails.market_data.circulating_supply || 'N/A'}
⏳ Time Active: ${'10 sec' || 'N/A'}
 ———————————
💰 Initial Investment: ${amountInEther} $METIS
📈 Current Worth: $${tokenDetails.market_data.current_price.usd || 'N/A'} $METIS
———————————
🔗 View on <a href="https://dexscreener.com/metis/0x3d60afecf67e6ba950b499137a72478b2ca7c5a1">Dexscreener </a>/ <a href="https://www.dextools.io/app/en/metis/pair-explorer/0x3d60afecf67e6ba950b499137a72478b2ca7c5a1?t=1732260491172">Dextools</a>
                                            `;
                        
                        // Inform the user about the successful transaction
                        await bot.sendMessage(chatId, successMessage, { parse_mode: 'HTML' });
                    } catch (error) {
                        const errorMessage = error.message.toLowerCase();
                        const firstLine = error.message.split('\n')[0];

                        // Specific error handling for gas fee and slippage issues
                        if (errorMessage.includes("gas fee")) {
                            await bot.sendMessage(chatId, `❌ ERROR: Transaction Failed (gas fee)👇\nMessage: 'Transaction failed due to lack of Metis for gas fee.'`);
                        } else if (errorMessage.includes("slippage") || errorMessage.includes("failed")) {
                            await bot.sendMessage(chatId, `❌ ERROR: Transaction Failed (slippage)👇\nMessage: 'Transaction failed slippage exceeded.'`);
                        } else {
                            await bot.sendMessage(chatId, `❌ Transaction failed: The transaction will be automatically resubmitted until successful. Please check your balance and try again if necessary.`);
                        }
                    }
                });

            });
        } catch (error) {
            // console.error('Error in buy process:', error);
            await bot.sendMessage(chatId, `Error: ${error.message}`);
        }
    }
    else if (query.data === "sell") {
        try {
            // Step 1: Ask for the token address
            await bot.sendMessage(chatId, "<b>Enter the Token Address (Metis Chain)</b> for the token you want to sell.",{parse_mode:'HTML'});

            // Step 2: Listen for the token address
            bot.once('message', async (tokenAddressMessage) => {
                const tokenAddress = tokenAddressMessage.text;
                const wallet = await getOrCreateWallet(username);

                // Fetch token balance
                const provider = new ethers.providers.JsonRpcProvider("https://metis-mainnet.g.alchemy.com/v2/pOQou5SizNPhHEY-zdCTI4yNHtP9_dkZ");
                const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, provider);
                const decimals = await tokenContract.decimals();
                const name = await tokenContract.name();
                const rawBalance = await tokenContract.balanceOf(wallet.address);
                const balanceInEther = ethers.utils.formatUnits(rawBalance, decimals);

                // Display balance and provide buttons
                await bot.sendMessage(
                    chatId,
                    `<b>Your current balance</b> ${balanceInEther + ' ' + name} .\nChoose the percentage to sell: 25% 50% 100%`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: "25%", callback_data: `sell_25_${tokenAddress}` },
                                    { text: "50%", callback_data: `sell_50_${tokenAddress}` },
                                    { text: "100%", callback_data: `sell_100_${tokenAddress}` }
                                ]
                            ]
                        },
                        parse_mode: 'HTML'
                    }
                );

                // Step 3: Handle button clicks
                bot.on('callback_query', async (callbackQuery) => {
                    const [action, percentage, selectedTokenAddress] = callbackQuery.data.split("_");

                    if (action === "sell" && selectedTokenAddress === tokenAddress) {
                        // Calculate the amount to sell based on the percentage
                        const percentageValue = parseInt(percentage, 10);
                        const amountToSell = rawBalance.mul(percentageValue).div(100); // BigNumber math for precision
                        console.log(amountToSell, decimals)
                        try {
                            const privateKey = wallet.privateKey;

                            // Convert amount to appropriate token decimals


                            // Keep your existing logic unchanged
                            const tokenIn = tokenAddress;
                            const tokenOut = '0x75cb093E4D61d2A2e65D8e0BBb01DE8d89b53481';
                            const recipient = wallet.address;
                            const slippageTolerance = 0.02; // 2% slippage tolerance

                            // Execute the swap
                            const receipt = await initializeAndExecute(privateKey, amountToSell, tokenIn, tokenOut, recipient, slippageTolerance);
                            
                            const tokenDetails = await getTokenDetails(tokenOut);
                      
    const successMessage = `
<b>🔱 Position Management 🔱</b>
    ———————————
    🔗 CA: ${tokenOut}
    ———————————
    🪙 Token: <a href="https://coinmarketcap.com/currencies/metisdao">${tokenDetails.name}</a>
    💥 Status: ${tokenDetails.market_data.price_change_24h}% Change
    💵 Price: $${tokenDetails.market_data.current_price.usd || 'N/A'} | Market Cap: $${tokenDetails.market_data.circulating_supply || 'N/A'}
    ⏳ Time Active: ${'10 sec' || 'N/A'}
     ———————————
    💰 Initial Investment: ${amountInEther} $METIS
    📈 Current Worth: $${tokenDetails.market_data.current_price.usd || 'N/A'} $METIS
    ———————————
    🔗 View on <a href="https://dexscreener.com/metis/0x3d60afecf67e6ba950b499137a72478b2ca7c5a1">Dexscreener</a> / <a href="https://www.dextools.io/app/en/metis/pair-explorer/0x3d60afecf67e6ba950b499137a72478b2ca7c5a1?t=1732260491172">Dextools</a>
                                                `;
                            // Inform the user about the successful transaction
                            await bot.sendMessage(chatId, successMessage, { parse_mode: 'HTML' });
                        } catch (error) {
                            const errorMessage = error.message.toLowerCase();
                            const firstLine = error.message.split('\n')[0];

                            // Specific error handling for gas fee and slippage issues
                            if (errorMessage.includes("gas fee")) {
                                await bot.sendMessage(chatId, `❌ ERROR: Transaction Failed (gas fee)👇\nMessage: 'Transaction failed due to lack of Metis for gas fee.'`);
                            } else if (errorMessage.includes("slippage") || errorMessage.includes("failed")) {
                                await bot.sendMessage(chatId, `❌ ERROR: Transaction Failed (slippage)👇\nMessage: 'Transaction failed slippage exceeded.'`);
                            } else {
                                await bot.sendMessage(chatId, `❌ Transaction failed. The transaction will be automatically resubmitted until successful. Please check your balance and try again if necessary.`);
                            }
                        }
                    }
                });
            });
        } catch (error) {
            await bot.sendMessage(chatId, `Error: ${error.message}`);
        }
    }
    else if (query.data === "slippage") {
        bot.sendMessage(chatId, "📉 <b>Enter the desired slippage</b> (e.g., 0.5%):", {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "1%", callback_data: "slippage_1" },
                        { text: "5%", callback_data: "slippage_5" },
                        { text: "10%", callback_data: "slippage_10" },
                        { text: "25%", callback_data: "slippage_25" }
                    ],
                    [{ text: "Custom Value", callback_data: "slippage_custom" }],
                    [{ text: "⬅️ Back", callback_data: "settings" }]
                ]
            }
        });
    } 
    else if (query.data.startsWith("slippage_")) {
        const value = query.data.split("_")[1];
        
        if (value === "custom") {
            bot.sendMessage(chatId, "📉 <b>Enter your custom slippage value</b> (0.1% - 25%):", {
                parse_mode: 'HTML'
            });
            bot.once("message", (msg) => {
                const slippage = parseFloat(msg.text.trim());
                if (slippage >= 0.1 && slippage <= 25) {
                    bot.sendMessage(chatId, `✔️ Slippage set to ${slippage}%`, {
                        reply_markup: mainMenuButtons.reply_markup
                    });
                } else {
                    bot.sendMessage(chatId, "❌ Invalid slippage value. Please enter a value between 0.1% and 25%.");
                }
            });
        } else {
            const slippage = parseInt(value);
            bot.sendMessage(chatId, `✔️ Slippage set to ${slippage}%`, {
                reply_markup: mainMenuButtons.reply_markup
            });
        }
    }
    else if (query.data === "delete_pin") {
        bot.sendMessage(chatId, "⚠️ Are you sure you want to delete your PIN? This will disable PIN protection.", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "Yes, Delete PIN", callback_data: "confirm_delete_pin" }],
                    [{ text: "Cancel", callback_data: "cancel_delete_pin" }]
                ]
            }
        });
    }
    else if (query.data === "confirm_delete_pin") {
        const username = query.from.username || `user_${chatId}`;

        // Function to delete the PIN from Firestore
        async function deletePin(username) {
            const userRef = db.collection('users').doc(username);
            await userRef.update({ pin: admin.firestore.FieldValue.delete() });
        }

        // Delete the PIN and notify the user
        deletePin(username).then(async () => {
            const settingsMenu = await handleSettingsMenu(username);
            bot.sendMessage(chatId, "✔️ Your PIN has been deleted. PIN protection is now disabled.", {
                reply_markup: settingsMenu.reply_markup
            });
        }).catch((error) => {
            console.error("Error deleting PIN:", error);
            bot.sendMessage(chatId, "❌ An error occurred while deleting your PIN. Please try again.");
        });
    }

    // Handle cancellation of delete action
    else if (query.data === "cancel_delete_pin") {
        bot.sendMessage(chatId, "🔄 PIN deletion canceled.", {
            reply_markup: settingsMenu.reply_markup
        });
    }

    else if (query.data === "community") {
        bot.sendMessage(chatId, "👥 Join our community on Telegram to stay updated and connected!");
    } else if (query.data === "refresh") {
        bot.sendMessage(chatId, "🔄 Refreshing your data...", {
            reply_markup: mainMenuButtons.reply_markup
        });
    } else if (query.data === "main_menu") {
        bot.sendMessage(chatId, "🔱 Main Menu:", {
            reply_markup: mainMenuButtons.reply_markup
        });
    } else if (query.data === "staking") {
        bot.sendMessage(chatId, "🔥 <b>Staking Feature Coming Soon!</b> Stay tuned for updates!" ,{parse_mode:'HTML'});
    }
    // Other cases omitted for brevity
});


// Handle any errors globally
bot.on("polling_error", (error) => {
    console.error(`Polling error: ${error.message}`);
});
