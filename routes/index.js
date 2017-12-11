var express = require('express');

var env = process.env.NODE_ENV || 'development';
var config = require('../config')[env];

var request = require('request');
var IOTA = require('iota.lib.js');
var router = express.Router();

var socketApi = require('../socketApi');
var io = socketApi.io;
var db = require('../filedb/app');

var sockets = [];
var xmrToBtc = 0;
var miotaToBtc = 0;
var iotaUSD = 0;
var payoutPer1MHashes = 0;
var hashIotaRatio = 0;
var totalIotaPerSecond = 0;
var final = 0;
var balanceInProgress = false;
var powInProgress = false;
var blockSpammingProgress = false;
var confirmedSpams = 0;
var countUsersForPayout = 0;
// cache global data
var cacheBalance = 0;
var cacheTransfers = [];
var cacheTotalValue = 0;
var cacheHashIotaratio = 0;
var tempCachesBundleHash = "";
// init table variable for file database
var tableCaches;
var tableQueue;
// External compute unit
var externalComputeSocket = [];

// List of https providers
const httpsProviders = [
    "https://iota.onlinedata.cloud:14443"
];
var _currentProvider = getRandomProvider();

function getRandomProvider() {
    return httpsProviders[Math.floor(Math.random() * httpsProviders.length)]
}

// Multi threading
var cp = require('child_process');
// Create IOTA instance with host and port as provider
var iota = new IOTA({
    'host': config.iota.host,
    'port': config.iota.port
});

// Init
// Request on startup
getRates("cacheBalance");
getRates("price");

setInterval(function () {
    getRates("price");
    // Wait 5 seconds and send new data to users
    setTimeout(function(){
        cacheHashIotaratio = getHashIotaRatio();
        emitGlobalValues("", "rates");
    }, 5000);
}, 60000);

function getRates(type){
    switch(String(type)) {
        case "balance":
            // Set balanceInProgress also here for block spamming, until balance progress is done
            balanceInProgress = true;
            var taskIsNodeSyncedForGetRates = function () {
                isNodeSynced("getRates (balance)", function (error, synced) {
                    if (synced) {
                        getBalance();
                    } else {
                        setTimeout(function () {
                            taskIsNodeSyncedForGetRates();
                        }, 5000);
                    }
                });
            };
            taskIsNodeSyncedForGetRates();
            break;
        case "cacheBalance":
            tableCaches = db.select("caches");
            for (var i in tableCaches.seeds) {
                cacheBalance += tableCaches.seeds[i].balance;
            }
            break;
        case "price":
            getTotalIotaPerSecond();
            getPayoutPer1MHashes();
            getXmrToBtc();
            getIotaPrice();
            break;
    }
}

// #BLOCK GET ALL NEEDED DATA FOR CALCULATE PAYOUT
function getHashIotaRatio(){
    // CoinHive convert BTC payout per 1 milion monero hashes
    var xmrInBtcPayout  = xmrToBtc / (1 / payoutPer1MHashes);
    //Convert monero BTC reward to per hash and btc price per 1x iota not million iotas. Ang get result how many iota per coinhive hash
    final = (xmrInBtcPayout/1000000) / (miotaToBtc / 1000000);
    final = final / (100 / config.coinhive.feeRatio);
    hashIotaRatio = final;
    return hashIotaRatio;
}

function getPayoutPer1MHashes(){
    request.get({url: "https://api.coinhive.com/stats/payout", qs: {"secret": config.coinhive.privateKey}}, function(error, response, body) {
        if (!error && response.statusCode == 200) {
            var info = JSON.parse(body);
            payoutPer1MHashes = info.payoutPer1MHashes;
            config.debug && console.log(new Date().toISOString()+" payoutPer1MHashes: " + payoutPer1MHashes);
        }
    });
}

function getTotalIotaPerSecond(){
    request.get({url: "https://api.coinhive.com/stats/site", qs: {"secret": config.coinhive.privateKey}}, function(error, response, body) {
        if (!error && response.statusCode == 200) {
            var info = JSON.parse(body);
            totalIotaPerSecond = (info.hashesPerSecond*cacheHashIotaratio).toFixed(2);
            config.debug && console.log(new Date().toISOString()+" getTotalIotaPerSecond: " + totalIotaPerSecond);
            config.debug && console.log(new Date().toISOString()+" hashIotaRatio: " + hashIotaRatio);
        }
    });
}

function  getXmrToBtc() {
    request.get({url: "https://api.coinmarketcap.com/v1/ticker/monero/"}, function(error, response, body) {
        if (!error && response.statusCode == 200) {
            var info = JSON.parse(body);
            xmrToBtc = info[0].price_btc;
            config.debug && console.log(new Date().toISOString()+" xmrToBtc: " + xmrToBtc);
        }
    });
}

function  getIotaPrice() {
    request.get({url: "https://api.coinmarketcap.com/v1/ticker/iota/"}, function(error, response, body) {
        if (!error && response.statusCode == 200) {
            var info = JSON.parse(body);
            miotaToBtc = info[0].price_btc;
            iotaUSD = info[0].price_usd / 1000000;
            config.debug && console.log(new Date().toISOString()+" miotaToBtc: " + miotaToBtc + "iotaUSD: " + iotaUSD);
        }
    });
}

function getNumberOfOutputsInBundle(){
    if(externalComputeSocket.length > 0){
        return config.externalOutputsInBundle;
    } else {
        return config.outputsInBundle;
    }
}

function cleanQueueDuplicity(){
    var addresses = db.select("queue").addresses;
    console.log("Count in queue (removing duplicity): " + addresses.length);
    var address = "";
    for (var i in addresses) {
        if(address !== addresses[i]){
            address = addresses[i];
            var firstMatch = address;
            // Remove duplicity requests from whole queue
            var tempNewQueue = {"type":[],"ids":[],"addresses":[],"value":[]};
            // Read until actual queue is not empty
            tableQueue = db.select("queue");
            var whileLength = tableQueue.type.length;
            while (whileLength > 0){
                var tempType = tableQueue.type.shift();
                var tempId = tableQueue.ids.shift();
                var tempAddress = tableQueue.addresses.shift();
                var tempValue = tableQueue.value.shift();
                // If actual address for withdrawal isnt in queue, add it again to tempNewQueue
                if(firstMatch !== "" && firstMatch == tempAddress){
                    tempNewQueue.type.push(tempType);
                    tempNewQueue.ids.push(tempId);
                    tempNewQueue.addresses.push(tempAddress);
                    tempNewQueue.value.push(tempValue);
                    firstMatch = "";
                } else if(address !== tempAddress){
                    tempNewQueue.type.push(tempType);
                    tempNewQueue.ids.push(tempId);
                    tempNewQueue.addresses.push(tempAddress);
                    tempNewQueue.value.push(tempValue);
                } else if(tempValue !== 0){
                    // For custom payout allow multiple in queue
                    tempNewQueue.type.push(tempType);
                    tempNewQueue.ids.push(tempId);
                    tempNewQueue.addresses.push(tempAddress);
                    tempNewQueue.value.push(tempValue);
                } else {
                    //console.log(new Date().toISOString() + " Failed: Duplicate payout request in queue: " + tempAddress);
                }
                whileLength--;
            }
            // Update final tempNewQueue to queue table
            db.update("queue", tempNewQueue);
        }
    }
    console.log("New count in queue: " + tempNewQueue.addresses.length);

}

// Actual round of seed
var seedRound = 0;
// Init default seeds from config
var getCaches = db.select("caches");
if(getCaches.seeds.length === 0){
    var getSeeds = config.iota.seeds.seeds;
    for (var i in getSeeds) {
        // Fill temp data
        var tempSeed = {"seed":null,"keyIndex":0,"balance":0,"withdrawalInProgress":false,"isReattachable":null,"resetUserBalanceList":[],"trytes":[],"bundleHash":null,"queueTimer":0,"nextQueueTimer":40};
        tempSeed.seed = getSeeds[i].seed;
        tempSeed.keyIndex = getSeeds[i].keyIndex;
        // Add temp data to JSON array
        getCaches.seeds.push(tempSeed);
    }
    // Update to file db
    db.update("caches", getCaches);
}

//#BLOCK OF WITHDRAWAL FUNCTION
function startNewPayout(){
    config.debug && console.log(new Date().toISOString()+" Info: startNewPayout() started");
    var queueAddresses = db.select("queue").addresses;
    tableCaches = db.select("caches");

    if(queueAddresses.length > 0 && tableCaches.seeds[seedRound].balance > 0 && hashIotaRatio > 0 && !tableCaches.seeds[seedRound].withdrawalInProgress && !balanceInProgress && !blockSpammingProgress) {
        config.debug && console.log(new Date().toISOString()+" Info: getUserForPayout() started");
        // Set withdraw is in progress
        blockSpammingProgress = true;
        tableCaches.seeds[seedRound].withdrawalInProgress = true;
        db.update("caches", tableCaches);
        // Clean duplicity from queue before new payout
        cleanQueueDuplicity();
        //Reset countUsersForPayout to zero for new payout. Fixing for new seeds generate own transactions not use previous.
        countUsersForPayout = 0;
        getUserForPayout();
    } else if (queueAddresses.length === 0 && tableCaches.seeds[seedRound].balance > 0 && hashIotaRatio > 0 && !tableCaches.seeds[seedRound].withdrawalInProgress && !balanceInProgress && !blockSpammingProgress && config.automaticWithdrawal){
        config.debug && console.log(new Date().toISOString()+" Info: getTopUsers() started");
        // If queue is empty, make auto withdrawal to unpaid users
        config.debug && console.log(new Date().toISOString()+" Queue is empty, make auto withdrawal to unpaid users");

        // Set withdraw is in progress
        blockSpammingProgress = true;
        tableCaches.seeds[seedRound].withdrawalInProgress = true;
        db.update("caches", tableCaches);

        getTopUsers(getNumberOfOutputsInBundle());
    } else if (!balanceInProgress && !powInProgress && !blockSpammingProgress && config.spamming){
        config.debug && console.log(new Date().toISOString()+" Info: doSpamming() started");
        // When PoW is sleeping (waiting on confirmation of value transactions), use it for spamming
        //Experiment with spamming mode when no withdrawal
        blockSpammingProgress = true;

        var taskIsNodeSyncedForSpamming = function () {
            isNodeSynced("doSpamming", function repeat(error, result) {
                if(result){
                    doSpamming();
                } else {
                    setTimeout(function(){
                        taskIsNodeSyncedForSpamming();
                    }, 5000);
                }
            });
        };
        taskIsNodeSyncedForSpamming();

    } else if(tableCaches.seeds[seedRound].balance === 0){
        config.debug && console.log(new Date().toISOString() + " Warning: This seed have zero balance, switch to next");
        switchToNextSeedPosition();
    } else if (queueAddresses.length === 0 && tableCaches.seeds[seedRound].balance > 0 && hashIotaRatio > 0 && !tableCaches.seeds[seedRound].withdrawalInProgress && !powInProgress){
        config.debug && console.log(new Date().toISOString() + " Info: Queue is empty, waiting 30 seconds for new attempt");
        setTimeout(function(){
            startNewPayout();
        }, 30000);
    } else if(hashIotaRatio === 0){
        config.debug && console.log(new Date().toISOString()+" Info: Waiting on getRates, hashIotaRatio is undefined");
        getRates("price");
        setTimeout(function(){
            config.debug && console.log(new Date().toISOString()+" Info: Calling startNewPayout() again");
            startNewPayout();
        }, 30000);
    }
}

function getUserForPayout(){
    tableQueue = db.select("queue");
    tableCaches = db.select("caches");
    var queueAddresses = tableQueue.addresses;

    if( tableCaches.seeds[seedRound].withdrawalInProgress && queueAddresses.length > 0 && countUsersForPayout < parseInt(getNumberOfOutputsInBundle()) ) {
        countUsersForPayout++;
        // Remove socket id and socket for waiting list (using for get position in queue)
        var socketId = tableQueue.ids.shift();
        var requestType = tableQueue.type.shift();
        var requestValue = tableQueue.value.shift();

        // Remove used address from array (get right position in queue)
        var userName = tableQueue.addresses.shift();

        db.update("queue", tableQueue);
        tableQueue = null;

        if(sockets !== undefined ) {
            // Is user socket.id is online, emit he is now in progress
            for (var i = 0; i < sockets.length; ++i) {
                if(socketId === sockets[i].id){
                sockets[i].emit('queuePosition', {position:0});
                break;
                }
            }
        }

        config.debug && console.log(new Date().toISOString() + " Withdrawal in progress for " + userName);

        getUserBalance(userName, requestType, requestValue);
    }
    else if(tableCaches.seeds[seedRound].withdrawalInProgress && queueAddresses.length === 0 && countUsersForPayout < parseInt(getNumberOfOutputsInBundle()) && config.automaticWithdrawal){
        var outputsTransactionLeft = parseInt(getNumberOfOutputsInBundle()) - parseInt(countUsersForPayout);
        if(outputsTransactionLeft > 0){
            getTopUsers(outputsTransactionLeft);
        }
    }
    else if(tableCaches.seeds[seedRound].withdrawalInProgress) {
        // Send to waiting sockets in queue their position
        sendQueuePosition();
        //No more addresses in queue or max countUsersForPayout, lets preprepareLocalTransfersp
        config.debug && console.log(new Date().toISOString()+" getUserForPayout transactions in cacheTransfers: " + cacheTransfers.length);
        config.debug && console.log(new Date().toISOString()+" getUserForPayout total amount for prepareLocalTransfers : " + cacheTotalValue);
        // If no total value for make transfer, reset payout and start again
        if(cacheTotalValue > 0 && cacheTransfers.length > 0){
            prepareLocalTransfers();
        } else {
            resetPayout();
            switchToNextSeedPosition();
        }
    }
}

function getUserBalance(address, type, customValue){
    request.get({url: "https://api.coinhive.com/user/balance", qs: {"secret": config.coinhive.privateKey, "name": address}}, function (error, response, body) {
        if (!error && response.statusCode === 200) {
            console.log(new Date().toISOString()+" countUsersForPayout: " + countUsersForPayout);
            var data = JSON.parse(body);
            if(data.error){
                console.log(new Date().toISOString()+" Error: Unknown address!");
                // Skip this user and continue
                countUsersForPayout = parseInt(countUsersForPayout) - 1;
                getUserForPayout();
            }  else {
                // Temp payout for skip amount when is not enough balance
                console.log(new Date().toISOString()+" customValue: " + customValue);
                if(customValue === 0){
                    var tempPayout = Math.floor(data.balance*hashIotaRatio);
                } else {
                    var tempPayout = Math.round(customValue);
                }
                //Check if we have balance for transfer
                tableCaches = db.select("caches");
                if((parseInt(cacheTotalValue)+parseInt(tempPayout)) < tableCaches.seeds[seedRound].balance){
                    var valuePayout = tempPayout;
                    cacheTotalValue += valuePayout;
                    // We can´t payout 0 value reward
                    if(valuePayout > 0){
                        var skipDuplicate = false;
                        //Check duplicity only for withdrawal, not custom transactions
                        if(customValue === 0) {
                            // If getTopUsers called from getUserBalance fill rest of space for manual payments, checking for duplicate
                            console.log(new Date().toISOString() + " Checking for duplicates");
                            tableCaches.seeds.forEach(function(seed) {
                                seed.resetUserBalanceList.forEach(function(user) {
                                    if(user.name === address){
                                        console.log(new Date().toISOString() + " Failed: Duplicate payout in resetUserBalanceList: " + address);
                                        // When duplicate do not add more, skip this user and continue
                                        skipDuplicate = true;
                                    }
                                });
                            });
                        } else {
                            console.log(new Date().toISOString() + " Custom payout, skipping check duplicates!");
                        }

                        if(!skipDuplicate) {
                            console.log(new Date().toISOString() + " No duplicates, can continue");
                            var tmpAddress = getAddressWithoutChecksum(address);
                            if(tmpAddress !== null){
                                isAddressAttachedToTangle(tmpAddress, function (error, result) {
                                    console.log(new Date().toISOString() + " Begin: isAddressAttachedToTangle");
                                    if(error !== null){
                                        console.log(new Date().toISOString() + " Error: isAddressAttachedToTangle!");
                                        console.log(error);
                                        // Repeat
                                        getUserBalance(address, type, customValue);
                                    } else {
                                        if (result === 1 || result === 0) {
                                            console.log(new Date().toISOString() + " isAddressAttachedToTangle result: " + result + " customValue: " + customValue);
                                            if (customValue === 0) {
                                                addTransferToCache(type, address, valuePayout, data.balance);
                                            } else {
                                                addTransferToCache(type, address, customValue, Math.floor(parseFloat(customValue / hashIotaRatio)));
                                            }

                                        } else if (result === -1) {
                                            // If address is not in tangle, reset username on coinhive to get it out from top users
                                            resetUserBalance(address);
                                        }
                                        // Success, we are done, go to next
                                        getUserForPayout();
                                    }
                                });
                            } else {
                                config.debug && console.log(new Date().toISOString()+" Failed: Address have wrong checksum, skipping!");
                                countUsersForPayout = parseInt(countUsersForPayout) - 1;
                                // Failed, go to next
                                getUserForPayout();
                            }
                        } else {
                            config.debug && console.log(new Date().toISOString()+" Warning: Duplicate, skipping! countUsersForPayout - 1");
                            countUsersForPayout = parseInt(countUsersForPayout) - 1;
                            // Failed, go to next
                            getUserForPayout();
                        }
                    } else {
                        config.debug && console.log(new Date().toISOString()+" Failed: getUserBalance no hashes for payout! Skipping");
                        countUsersForPayout = parseInt(countUsersForPayout) - 1;
                        // Failed, go to next
                        getUserForPayout();
                    }
                } else {
                    // We have already some transfer data break to prepareLocalTransfers
                    if(cacheTransfers.length > 0){
                        // Send prepared transfers if no more balance for next
                        config.debug && console.log(new Date().toISOString()+" getUserBalance transactions in cacheTransfers: " + cacheTransfers.length);
                        config.debug && console.log(new Date().toISOString()+" getUserBalance total amount for prepareLocalTransfers : " + cacheTotalValue);
                        prepareLocalTransfers();
                    } else {
                        console.log(new Date().toISOString()+" No more balance for next payout!");
                        if(cacheTotalValue > 0){
                        cacheTransfers.push({
                            "address" : config.remainingBalanceAddress,
                            "value"  : parseInt(tableCaches.seeds[seedRound].balance),
                            "message" : "MINEIOTADOTCOM9AUTOMATIC9PAYOUT",
                            'tag': "MINEIOTADOTCOM"
                        });

                        tableCaches.seeds[seedRound].balance = 0;
                        db.update("caches", tableCaches);

                        prepareLocalTransfers();
                        } else {
                            tableCaches.seeds[seedRound].balance = 0;
                            db.update("caches", tableCaches);
                            switchToNextSeedPosition();
                        }
                    }
                }
            }
        } else {
            // Repeat
            getUserBalance(address, type, customValue);
        }
    });
}

function addTransferToCache(type, address, amount, hashes){
    var withoutChecksumAddress = getAddressWithoutChecksum(address);
        if(withoutChecksumAddress !== null){
        if(type === "MANUAL" || type === "AUTOMATIC"){
            cacheTransfers.push({
                "address" : withoutChecksumAddress,
                "value"  : parseInt(amount),
                "message" : "MINEIOTADOTCOM9"+type+"9PAYOUT",
                'tag': "MINEIOTADOTCOM"
            });
        } else {
            cacheTransfers.push({
                "address" : withoutChecksumAddress,
                "value"  : parseInt(amount),
                "message" : "MINEIOTADOTCOM9CUSTOM9PAYOUT",
                'tag': type
            });
        }

        //After transaction is confirmed, withdraw coinhive.com balance
        tableCaches = db.select("caches");
        tableCaches.seeds[seedRound].resetUserBalanceList.push({"name":address,"amount":hashes});
        db.update("caches", tableCaches);
    }
}

function getTopUsers(count){
    request.get({url: "https://api.coinhive.com/user/top", qs: {"secret": config.coinhive.privateKey,"count":count,"order":"balance"}}, function(error, response, body) {
        if (!error && response.statusCode == 200) {
            var data = JSON.parse(body);
            for (var i = 0, len = data.users.length; i < len; i++) {
                // Temp payout for skip amount when is not enough balance
                var valuePayout = Math.floor(data.users[i].balance * hashIotaRatio);
                if(valuePayout > 0){
                    var address = data.users[i].name;
                    var skipDuplicate = false;
                    // If getTopUsers called from getUserBalance fill rest of space for manual payments, checking for duplicate
                    if(count < parseInt(getNumberOfOutputsInBundle())){
                        tableCaches = db.select("caches");
                        tableCaches.seeds.forEach(function(seed) {
                            seed.resetUserBalanceList.forEach(function(user) {
                                if(user.name === address){
                                    console.log(new Date().toISOString()+" Duplicate payout in resetUserBalanceList, skipping! " + address);
                                    // When duplicate do not add more, skip this user and continue
                                    skipDuplicate = true;
                                }
                            });
                        });
                    }
                    if(!skipDuplicate){
                        tableQueue = db.select("queue");
                        // Push type of withdrawal
                        tableQueue.type.push("AUTOMATIC");
                        // Custom payout request
                        tableQueue.value.push(0);
                        // Push empty socket id for automatic withdrawal do not need
                        tableQueue.ids.push("");
                        // Push address to array
                        tableQueue.addresses.push(address);
                        // Send to client position in queue
                        db.update("queue", tableQueue);
                        tableQueue = null;
                    } else {
                        config.debug && console.log(new Date().toISOString()+" countUsersForPayout - 1!");
                        countUsersForPayout = parseInt(countUsersForPayout) - 1;
                    }
                } else {
                    console.log(new Date().toISOString()+" User without balance for payout, skipping!");
                }

            }
            getUserForPayout();
        } else {
            resetPayout();
        }
    });
}

function prepareLocalTransfers(){

    config.debug && console.log(new Date().toISOString()+' Transfer worker started');
    config.debug && console.time('trytes-time');
    // Worker for prepare TRYTES transfer
    var transferWorker = cp.fork('workers/transfer.js');

    tableCaches = db.select("caches");
    transferWorker.send({seed:tableCaches.seeds[seedRound].seed,keyIndex:tableCaches.seeds[seedRound].keyIndex});
    transferWorker.send({totalValue:cacheTotalValue});
    transferWorker.send(cacheTransfers);

    transferWorker.on('message', function(result) {
        // Receive results from child process
        if(result.status === "success"){
            // Select actual tableCache
            tableCaches.seeds[seedRound].trytes = result.result;

            //We store actual keyIndex for next faster search and transaction
            if(typeof result.keyIndex !== 'undefined'){
                tableCaches.seeds[seedRound].keyIndex = result.keyIndex;
                config.debug && console.log(new Date().toISOString()+' Transfer: store actual keyIndex: '+result.keyIndex);
            }
            if(typeof result.inputAddress !== 'undefined'){
                config.debug && console.log(new Date().toISOString()+' Now waiting at funds are moved from: '+result.inputAddress);
                tableCaches.seeds[seedRound].isReattachable = result.inputAddress ;
            } else {
                // Something wrong, next in queue can go
                resetPayout();
            }
            db.update("caches", tableCaches);

            // Trytes are finished, delete cacheTransfers and cacheTotalValue
            cacheTransfers = [];
            cacheTotalValue = 0;
             callPoW();


        } else if (result.status == "error"){
            config.debug && console.log(result);
            // Error transfer worker switch to next seed
            resetPayout();
            switchToNextSeedPosition()
        }
        transferWorker.kill();
    });
    transferWorker.on('close', function () {
        config.debug && console.log(new Date().toISOString()+' Closing transfer worker');
        console.timeEnd('trytes-time');
    });
}

function sendQueuePosition(socket){
    var queueIds = db.select("queue").ids;
    if(socket !== undefined){
        socket.emit('queueTotal', {total: queueIds.length});
    } else if(sockets !== undefined ) {
            // Emit to user in queue his position.
            sockets.forEach(function (socket){
                if(queueIds.indexOf(socket.id) !== -1){
                    //config.debug && console.log(new Date().toISOString()+" "+socket.id+" is in queue " + (parseInt(queueIds.indexOf(socket.id))+parseInt(1)));
                    socket.emit('queuePosition', {position: (parseInt(queueIds.indexOf(socket.id))+parseInt(1))});
                }
            });
        // Emit to users total queue
        emitToAll('queueTotal', {total: queueIds.length});
    }
}
if(!config.maintenance){
    isReattachable();
} else {
    setInterval(function () {
        emitToAll('announcement', "Site is in maintenance, restarting iri node...")
    }, 30000);

}

// Checking if transaction is confirmed
function isReattachable(){
    isNodeSynced("isReattachable", function repeat(error, synced) {
        if(!powInProgress && synced) {
            tableCaches = db.select("caches");
            if(tableCaches.seeds[seedRound].isReattachable !== undefined){
            var checkAddressIsReattachable = tableCaches.seeds[seedRound].isReattachable;
            } else {
                setTimeout(function () {
                    config.debug && console.log(new Date().toISOString() + 'Error: isReattachable is undefined, call isReattachable after 10 seconds');
                    isReattachable();
                }, 10000);
            }
            var queueTimer = tableCaches.seeds[seedRound].queueTimer;
            var queueAddresses = db.select("queue").addresses;

            if (parseInt(queueTimer) > (parseInt(config.skipAfterMinutes)*parseInt(2)) && parseInt(queueAddresses.length) > 0 && config.skipWithdrawal) {
                // In transaction is not confirmed after 45 minutes, skipping to the next in queue
                config.debug && console.log(new Date().toISOString() + 'Error: Transaction is not confirmed after 45 minutes, skipping to the next in queue');
                // Error: Transaction is not confirmed, resetPayout
                resetPayout();
            }

            if (checkAddressIsReattachable !== null) {
                // Add 30 second for each seed, where we waiting 30 seconds before come this on turn
                // Only if  isReattachable is not called from confirmation of proof of work

                var nextQueueTimer = tableCaches.seeds[seedRound].nextQueueTimer;
                if(queueTimer > 0){
                    queueTimer = queueTimer + (parseInt(tableCaches.seeds.length)-1);
                } else {
                    queueTimer++;
                }

                config.debug && console.log('################################################################################################################################');
                config.debug && console.log(new Date().toISOString() + ' Actual queue run for minutes: ' + queueTimer / 2);
                config.debug && console.log(new Date().toISOString() + ' Next queue run for minutes: ' + nextQueueTimer / 2);
                config.debug && console.log(new Date().toISOString() + ' Seed position: ' + seedRound);
                config.debug && console.log(new Date().toISOString() + ' Check bundle confirmation: ' + tableCaches.seeds[seedRound].bundleHash);
                tableCaches.seeds[seedRound].queueTimer = queueTimer;
                db.update("caches", tableCaches);

                iota.api.isReattachable(checkAddressIsReattachable, function (errors, Bool) {
                    // If false, transaction was confirmed
                    if (!Bool) {
                        // We are done, next in queue can go
                        config.debug && console.log(new Date().toISOString() + " Success: Transaction is confirmed: " + checkAddressIsReattachable);
                        // Get and emit new balance after transaction confirmation
                        getBalanceOfCurrentSeed(function (error, result) {
                            if(error !== null){
                                console.log(new Date().toISOString() + " Error: getBalanceOfCurrentSeed!");
                                console.log(error);
                                // Repeat
                                isReattachable();
                            } else {
                                if (result) {
                                    withdrawUserBalance();
                                } else {
                                    switchToNextSeedPosition();
                                }
                            }
                        });
                    } else if (queueTimer > nextQueueTimer && parseInt(queueTimer) !== 0) {
                        // Set and save next queue timer
                        nextQueueTimer = nextQueueTimer + (parseInt(config.reattachAfterMinutes)*parseInt(2));
                        tableCaches.seeds[seedRound].nextQueueTimer = nextQueueTimer;
                        db.update("caches", tableCaches);
                        // Add one minute to queue timer
                        // On every X minutes in queue, do PoW again
                        config.debug && console.log(new Date().toISOString() + ' Failed: Do PoW again ');
                        // Check if node is synced, this also call proof of work
                        callPoW();
                    } else {
                        config.debug && console.log(new Date().toISOString() + ' Miners online: ' + sockets.length);
                        config.debug && console.log(new Date().toISOString() + ' Transactions in queue: ' + queueAddresses.length);
                        switchToNextSeedPosition();
                    }
                });
            } else {
                config.debug && console.log(new Date().toISOString() + " Error: inputAddressConfirm: " + checkAddressIsReattachable);
                //Start new payout to next when is new seed added and have balance
                if(tableCaches.seeds[seedRound].resetUserBalanceList.length > 0){
                    withdrawUserBalance();
                } else if(tableCaches.seeds[seedRound].balance > 0){
                    resetPayout();
                    startNewPayout();
                } else {
                    switchToNextSeedPosition();
                }

            }
        } else {
            setTimeout(function(){
                config.debug && console.log(new Date().toISOString() + " Error: node is not synced, wait 10 and repeat ");
                isReattachable();
            }, 10000);
        }
    });
}

function withdrawUserBalance(){
    tableCaches = db.select("caches");
    // Withdraw from user balance with callback
    if(tableCaches.seeds[seedRound].resetUserBalanceList.length > 0){
        var x = 0;
        var loopUserBalanceList = function(arr) {
            if(typeof arr[x].name !== 'undefined'){
            withdrawFromUserBalance(arr[x].name, arr[x].amount, function (error, result) {
                if (result === 1) {
                    // Done continue, set x to next item
                    x++;
                    // any more items in array? continue loop
                    if (x < arr.length) {
                        loopUserBalanceList(arr);
                    } else {
                        //Continue to new payout
                        // Unset the cache values
                        resetPayout();
                        // Start new payout
                        startNewPayout();
                    }
                } else if (result === 0) {
                    // Reset
                    resetUserBalance(arr[x].name);
                    // Done continue, set x to next item
                    x++;
                    // any more items in array? continue loop
                    if (x < arr.length) {
                        loopUserBalanceList(arr);
                    } else {
                        //Continue to new payout
                        // Unset the cache values
                        resetPayout();
                        // Start new payout
                        startNewPayout();
                    }
                } else if (result === -1) {
                    // Repeat if http error
                    loopUserBalanceList(arr);
                }
            });
            } else {
                //Skipp because username is undefined
                config.debug && console.log(new Date().toISOString() + " Error: Skipp because username is undefined ");
                x++;
                loopUserBalanceList(arr);
            }
        };

        loopUserBalanceList(tableCaches.seeds[seedRound].resetUserBalanceList);
    } else {
        // There is nobody for withdraw payout from coinhive
        config.debug && console.log(new Date().toISOString() + " Warning: There is nobody for withdraw payout from coinhive.com ");
        // Unset the cache values
        resetPayout();
        // Switch to another seed
        switchToNextSeedPosition();
    }
}

function switchToNextSeedPosition(){
    seedRound++;
    // Check if new seed position is not bigger than we have seeds
    var getCaches = db.select("caches");
    if(seedRound > (parseInt(getCaches.seeds.length)-1)){
        seedRound = 0;
    }
    config.debug && console.log(new Date().toISOString() + ' Next seed position: ' + seedRound + " after 30 seconds");
    if(getCaches.seeds[seedRound].balance === 0){
        getRates("balance");
    }

    var taskSetTimeoutIsReattachable = function () {
        setTimeout(function(){
            if(!balanceInProgress){
                isReattachable();
            } else {
                config.debug && console.log(new Date().toISOString() + ' taskSetTimeoutIsReattachable: Balance is still in progress!!!');
                taskSetTimeoutIsReattachable();
            }
        }, 30000);
    };
    taskSetTimeoutIsReattachable();


}

// Reset total on coinhive.com on request
function resetUserBalance(userName){
    config.debug && console.log("resetUserBalance: "+userName);
    request.post({url: "https://api.coinhive.com/user/reset", form: {"secret": config.coinhive.privateKey, "name":userName}}, function(error, response, body) {
        if (!error && response.statusCode === 200) {
            config.debug && console.log(new Date().toISOString()+" Reset coinhive.com balance result:");
            config.debug && console.log(body);
        } else {
            config.debug && console.log(new Date().toISOString()+" Error response status code resetUserBalance");
        }
    });
}

// Withdraw from user balance on coinhive when transaction is confirmed
function withdrawFromUserBalance(name, amount, callback){
    request.post({url: "https://api.coinhive.com/user/withdraw", form: {"secret": config.coinhive.privateKey, "name":name, "amount":amount}}, function(error, response, body) {
        if (!error && response.statusCode === 200) {
            // If insufficient funds, reset balance to clear user.
            var data = JSON.parse(body);
            if(data.error === "insufficent_funds"){
                //resetUserBalance(name);
                callback(null, 0);
            }else {
                callback(null, 1);
            }
            config.debug && console.log(new Date().toISOString()+" Withdraw coinhive.com balance result:");
            config.debug && console.log(body);
        } else {
            config.debug && console.log(new Date().toISOString()+" Error response status code withdrawUserBalance");
            callback(null, -1);
        }
    });
}

function resetPayout(){
    // Finished or canceled transaction, can use power resources again for transaction / spam
    powInProgress = false;
    blockSpammingProgress = false;

    // Reset count users in actual payout preparation
    countUsersForPayout = 0;
    // Reset total value for getInputs in transfer worker and for check if mineiota have enough balance
    cacheTotalValue = 0;

    // Select actual tableCache
    tableCaches = db.select("caches");
    // Reset minutes before next queue, waiting on transaction confirmation
    tableCaches.seeds[seedRound].queueTimer = 0;
    // Set next queue timer when we start new payout
    tableCaches.seeds[seedRound].nextQueueTimer = parseInt(config.reattachAfterMinutes)*parseInt(2);
    // Set state for withdrawal progress
    tableCaches.seeds[seedRound].withdrawalInProgress = false;
    // input address from balance to checking if transaction is confirmed
    tableCaches.seeds[seedRound].isReattachable = null ;
    // Empty list of address for reset balance, we skipping to next in queue
    tableCaches.seeds[seedRound].resetUserBalanceList.length = 0;
    // Empty list of trytes data for sendTransaction (attacheToTangle)
    tableCaches.seeds[seedRound].trytes.length = 0;

    // Finally update table cache to file db
    db.update("caches", tableCaches);

    if(typeof cacheTransfers !== 'undefined'){
        cacheTransfers.length = 0;
    }
}

function callPoW(){
    if(!powInProgress){
        powInProgress = true;
        var taskIsNodeSyncedForCallPoW = function () {
            isNodeSynced("callPoW", function repeat(error, synced) {
                if (synced) {
                    if(config.externalCompute && externalComputeSocket.length > 0){
                        config.debug && console.log(new Date().toISOString()+" Info: External PoW worker started");
                        config.debug && console.time('external-pow-time');
                        externalComputeSocket[0].emit('boostAttachToTangle', db.select("caches").seeds[seedRound].trytes);
                    } else {
                        if(env === "production"){
                            //ccurlWorker();
                            doPow();
                        } else {
                            ccurlWorker();
                        }
                    }
                } else {
                    setTimeout(function(){
                        taskIsNodeSyncedForCallPoW();
                    }, 1000);
                }
            });
        };
        taskIsNodeSyncedForCallPoW();
    }
}

function doPow(){
    config.debug && console.log(new Date().toISOString()+" Info: Node PoW worker started");
    config.debug && console.time('pow-time');
    // Worker for get IOTA balance in interval
    var powWorker = cp.fork('workers/pow.js');
    // Send child process work to get IOTA balance
    //We pass to worker keyIndex where start looking for funds
    tableCaches = db.select("caches");
    powWorker.send({trytes:tableCaches.seeds[seedRound].trytes});

    powWorker.on('message', function(trytesResult) {
        // Receive results from child process
        // Get completed transaction info
        // Get only hash from attached transaction
        if(trytesResult.error === 1){
            config.debug && console.log(new Date().toISOString()+ " Error: doPow");
            config.debug && console.log(trytesResult);
            // IF error kill worker and start again after 5 seconds
            powWorker.kill();
            resetPayout();
        } else if(typeof trytesResult[0].bundle !== 'undefined') {
            tableCaches.seeds[seedRound].bundleHash = trytesResult[0].bundle;
            tempCachesBundleHash = trytesResult[0].bundle;
            db.update("caches", tableCaches);

            config.debug && console.log("Success: bundle from attached transactions " + trytesResult[0].bundle);

            powInProgress = false;
            // We have done PoW for transactions with value, now can use power for spamming
            blockSpammingProgress = false;
            // Wait 10 seconds after PoW is done, before skip to next seed
            setTimeout(function(){
                emitGlobalValues("", "bundle");
                // Go to next seed
                seedRound++;
                isReattachable();
            }, 10000);

            powWorker.kill();
        } else {
            config.debug && console.log(trytesResult);
            powWorker.kill();
            resetPayout();
        }
    });
    powWorker.on('close', function () {
        config.debug && console.log(new Date().toISOString()+' Closing PoW worker');
        config.debug && console.timeEnd('pow-time');
    });
}

function doSpamming(){
    config.debug && console.log(new Date().toISOString()+" Spam worker started");
    config.debug && console.time('spam-time');

    var spammerWorker = cp.fork('workers/spammer.js');
    spammerWorker.send("start");

    spammerWorker.on('message', function(result) {
        // Receive results from child process
        // Get completed transaction info
        // Get only hash from attached transaction
        if(result.error === 1){
            config.debug && console.error(new Date().toISOString()+ " Error: spammerWorker");
            config.debug && console.error(result);
            blockSpammingProgress = false;
        } else if(typeof result[0].bundle !== 'undefined') {
            confirmedSpams = parseInt(confirmedSpams) + 2;
            // Emit actual confirmed transactions by spamming network
            emitGlobalValues("" ,"confirmedSpams");
            if(env !== "production"){
            var theTangleOrgUrl = 'https://thetangle.org/bundle/'+result[0].bundle;
            config.debug && console.log("Success: bundle from attached transactions " +theTangleOrgUrl);
            }
            config.debug && console.log(new Date().toISOString()+' Success Spammer worker finished');
            config.debug && console.timeEnd('spam-time');
            blockSpammingProgress = false;
        }
        spammerWorker.kill();
    });
    spammerWorker.on('close', function () {
    });
}

function ccurlWorker(){

    var localAttachToTangle = function(trunkTransaction, branchTransaction, minWeightMagnitude, trytes, callback) {

        var ccurlHashing = require("../ccurl/index");

        ccurlHashing(trunkTransaction, branchTransaction, minWeightMagnitude, trytes, function(error, success) {
            if (error) {
                config.debug && console.error("Error Light Wallet: ccurl.ccurlHashing finished");
                config.debug && console.log(error);
            } else {
                //config.debug && console.log("Success Light Wallet: ccurl.ccurlHashing finished");
            }
            if (callback) {
                return callback(error, success);
            } else {
                return success;
            }
        });
    };

    iota.api.attachToTangle = localAttachToTangle;

    var depth = 3;
    var minWeightMagnitude = 14;
    config.debug && console.log(new Date().toISOString()+" PoW worker started");
    config.debug && console.time('pow-time');
    iota.api.sendTrytes(db.select("caches").seeds[seedRound].trytes, depth, minWeightMagnitude, function (error, success) {
        if (error) {
            console.error("Sorry, something wrong happened... lets try it again after 5 sec");
            config.debug && console.error(error);
            config.debug && console.timeEnd('pow-time');

            // Check if node is synced, this also call proof of work
            setTimeout(function(){
                callPoW();
            }, 5000);

        } else {
            tableCaches = db.select("caches");
            tableCaches.seeds[seedRound].bundleHash = success[0].bundle;
            tempCachesBundleHash = success[0].bundle;
            db.update("caches", tableCaches);

            var theTangleOrgUrl = 'https://thetangle.org/bundle/'+success[0].bundle;
            console.log("Success: bundle from attached transactions " +theTangleOrgUrl);

            emitGlobalValues("", "bundle");

            config.debug && console.log(new Date().toISOString()+' PoW worker finished');
            console.timeEnd('pow-time');

            powInProgress = false;
            // We have done PoW for transactions with value, now can use power for spamming
            blockSpammingProgress = false;
            // Switch to next seed
            seedRound++;
            isReattachable();
        }
    });
}

function isNodeSynced(type, callback){
    config.debug && console.log(new Date().toISOString()+" Checking if node is synced: " + type);
    iota.api.getNodeInfo(function(error, success){
        if(error) {
            config.debug && console.log(new Date().toISOString()+" Error occurred while checking if node is synced");
            config.debug && console.log(error);
            callback(null, false);
        } else {
            const isNodeUnsynced =
                success.latestMilestone == config.iota.seed ||
                success.latestSolidSubtangleMilestone == config.iota.seed ||
                success.latestSolidSubtangleMilestoneIndex < success.latestMilestoneIndex;

            const isNodeSynced = !isNodeUnsynced;

            if(isNodeSynced) {
                config.debug && console.log(new Date().toISOString()+" Node is synced");
                callback(null, true);
            } else {
                config.debug && console.log(new Date().toISOString()+" Failed: Node is not synced.");
                callback(null, false);
            }
        }

    });
}

//# BLOCK HELPERS FUNCTIONS
function isAddressAttachedToTangle(address, callback) {
    iota.api.findTransactions({"addresses":new Array(address)}, function (errors, success) {
        if(!errors){
            if(typeof success !== 'undefined') {
                if (success.length === 0) {
                    //config.debug && console.log(new Date().toISOString()+' Error: '+address+' is not attached and confirmed to tangle! ');
                    callback(null, -1);
                } else {
                    iota.api.getLatestInclusion(success, function (errors, success) {
                        if (success !== null) {
                            for (var i = 0, len = success.length; i < len; i++) {
                                if (success[i] === true) {
                                    callback(null, 1);
                                    return;
                                }
                            }
                            //config.debug && console.log(new Date().toISOString()+' Warning: '+address+' is attached, but not confirmed to tangle! ');
                            callback(null, 0);
                        } else {
                            // Problem with node?
                            callback(null, -2);
                        }
                    })
                }
            } else {
                callback(null, -2);
            }
        } else {
            console.log(errors);
        }
    });
}
function getAddressWithoutChecksum(address){
    // Get only 81-trytes address format
    // Check if address is 81-trytes address
    if(!isHash(address)){
        // If is address with checksum do check
        if(isValidChecksum(address)){
            // If is address correct, remove checksum
            address = noChecksum(address);
        } else {
            console.log(new Date().toISOString()+" invalid checksum: ");
            console.log(address);
            address = null;
        }
    }
    return address;
}
function isAddress(address){
    return iota.valid.isAddress(address);
}
function isHash(hash){
    return iota.valid.isHash(hash);
}
function isValidChecksum(addressWithChecksum){
    return iota.utils.isValidChecksum(addressWithChecksum);
}
function noChecksum(addressWithChecksum){
    return iota.utils.noChecksum(addressWithChecksum);
}

function getBalanceOfCurrentSeed(callback) {
    config.debug && console.log(new Date().toISOString()+" getBalanceOfCurrentSeed worker started");
    config.debug && console.time('balance-time');
    // Worker for get IOTA balance in interval
    var balanceWorker = cp.fork('workers/balance.js');
    // Send child process work to get IOTA balance
    //We pass to worker keyIndex where start looking for funds
    tableCaches = db.select("caches");
    balanceWorker.send({seed:tableCaches.seeds[seedRound].seed,keyIndex:tableCaches.seeds[seedRound].keyIndex});

    balanceWorker.on('message', function(balanceResult) {
        config.debug && console.log(balanceResult);
        if(balanceResult.inputs !== undefined && balanceResult.inputs.length > 0){
            //We store actual keyIndex for next faster search and transaction
            tableCaches.seeds[seedRound].keyIndex = balanceResult.inputs[0].keyIndex;

            if(Number.isInteger(balanceResult.totalBalance)){
                tableCaches.seeds[seedRound].balance = balanceResult.totalBalance;
                cacheBalance = 0;
                for (var i in tableCaches.seeds) {
                    cacheBalance += tableCaches.seeds[i].balance;
                }
                config.debug && console.log(new Date().toISOString()+" Total balance: " + cacheBalance);
            } else {
                cacheBalance = " Running syncing of database, please wait! "
            }

            db.update("caches", tableCaches);
            config.debug && console.log(new Date().toISOString()+' Balance: store actual keyIndex: '+balanceResult.inputs[0].keyIndex);
        }
        balanceWorker.kill();
    });
    balanceWorker.on('close', function () {
        config.debug && console.log(new Date().toISOString()+' Closing getBalanceOfCurrentSeed worker');
        console.timeEnd('balance-time');
        callback(null, true);
        emitGlobalValues("", "balance");
    });
}

function getBalance(){
    balanceInProgress = true;
    config.debug && console.log(new Date().toISOString()+" Balance worker started");
    config.debug && console.time('balance-time');
    // Worker for get IOTA balance in interval
    var balanceWorker = cp.fork('workers/balance.js');
    // Send child process work to get IOTA balance
    //We pass to worker keyIndex where start looking for funds
    tableCaches = db.select("caches");
    balanceWorker.send({seed:tableCaches.seeds[seedRound].seed,keyIndex:tableCaches.seeds[seedRound].keyIndex});

    balanceWorker.on('message', function(balanceResult) {
        // Receive results from child process
        balanceInProgress = false;
        config.debug && console.log(balanceResult);
        if(typeof balanceResult.inputs !== 'undefined' && balanceResult.inputs.length > 0){
            //We store actual keyIndex for next faster search and transaction
            tableCaches.seeds[seedRound].keyIndex = balanceResult.inputs[0].keyIndex;

            if(Number.isInteger(balanceResult.totalBalance)){
                tableCaches.seeds[seedRound].balance = balanceResult.totalBalance;
                cacheBalance = 0;
                for (var i in tableCaches.seeds) {
                    cacheBalance += tableCaches.seeds[i].balance;
                }
                config.debug && console.log(new Date().toISOString()+" Total balance: " + cacheBalance);
            } else {
                cacheBalance = " Running syncing of database, please wait! "
            }

            db.update("caches", tableCaches);
            config.debug && console.log(new Date().toISOString()+' Balance: store actual keyIndex: '+balanceResult.inputs[0].keyIndex);
        }
        balanceWorker.kill();
    });
    balanceWorker.on('close', function () {
        config.debug && console.log(new Date().toISOString()+' Closing balance worker');
        console.timeEnd('balance-time');
        emitGlobalValues("", "balance");
    });
}

function manualPayment(){
    cacheTransfers.push({
        "address" : "GLQRBYHTEVJDRGPUFNEBT9PIGFPKSRWPVDUTPEYMBDTNTZWLQZJ9H9QA9G9NFVHYOIYEZYQBTCTSHCOXADANQACY9C",
        "value"  : parseInt(0),
        "message" : "MINEIOTADOTCOM9AUTOMATIC9PAYOUT9CCURL",
        'tag': "MINEIOTADOTCOM"
    });
    prepareLocalTransfers();
}


// SOCKET.IO Communication
io.on('connection', function (socket) {
    // Set new connection socket to array
    sockets.push(socket);

    // Emit actual values to all users
    emitGlobalValues(socket, "all");

    //Emit actual length of queue
    sendQueuePosition(socket);

    // On disconnect remove socket from array sockets
    socket.on('disconnect', function(){
        var i = sockets.indexOf(socket);
        if(i != -1) {
            sockets.splice(i, 1);
        }
        if(socket === externalComputeSocket[0]){
            config.debug && console.log(new Date().toISOString()+' Warning: external compute unit is disconnected');
            externalComputeSocket = [];
        }
    });

    //When user set address check if is valid format
    socket.on('login', function (data, fn) {
        if(isAddress(data.address)){
            var address = getAddressWithoutChecksum(data.address);
            if(address !== null){
                isAddressAttachedToTangle(address, function(error, result) {
                    if(result === 1){
                        fn({done:1,publicKey:config.coinhive.publicKey,username:data.address});
                    } else if(result === 0) {
                        //console.log('Warning: '+address+' is attached, but not confirmed to tangle');
                        fn({done:0,publicKey:config.coinhive.publicKey,username:data.address});
                    } else if(result === -1) {
                        console.log('Error login: '+address+' is not attached to tangle');
                        fn({done:-1});
                    }
                });
            } else {
                console.log('Error login: '+address+' wrong checksum');
                fn({done:-2});
            }
        } else {
            fn(false);
        }
    });

    socket.on('externalComputeLogin', function (data, fn) {
            if(data.password === config.externalComputePassword){
                config.debug && console.log(new Date().toISOString()+' Success: external compute unit is connected');
                externalComputeSocket.push(socket);
                fn({done:1});
            } else {
                config.debug && console.log(new Date().toISOString()+' Error: external compute unit set wrong password');
                fn({done:0});
            }
    });

    //When user request actual balance
    socket.on('getUserActualBalance', function(data, fn) {
        request.get({url: "https://api.coinhive.com/user/balance", qs: {"secret": config.coinhive.privateKey, "name": data.address}}, function (error, response, body) {
            if (!error && response.statusCode === 200) {
                var data = JSON.parse(body);
                if(data.error){
                    fn({done:0});
                }  else {
                    // We can´t payout 0 value reward
                    var valuePayout = Math.floor(data.balance*hashIotaRatio);
                    fn({done:1, balance:valuePayout});
                }
            } else {
                fn({done:0});
            }
        });

    });

    //When user with request withdraw
    socket.on('withdraw', function(data, fn) {
        var fullAddress = data.address;
        var customTag = data.tag;
        var customValue = data.value;
        config.debug && console.log("Requesting withdraw for address: " + fullAddress);
        if(isAddress(fullAddress)){
            tableQueue = db.select("queue");
            var queueAddresses = tableQueue.addresses;
            // Check if withdrawal request inst already in queue
            if(queueAddresses.indexOf(fullAddress) >= 0 && customTag === null && customValue === null){
                fn({done:-1,position:(parseInt(queueAddresses.indexOf(fullAddress))+parseInt(1))});
            } else  {
                // Push type of withdrawal
                if(typeof customTag === 'undefined' && typeof customTag === 'undefined'){
                    //TODO remove after all will be updated
                    tableQueue.type.push("MANUAL");
                    tableQueue.value.push(0);
                } else {
                    if(customTag === null || customValue === null){
                        tableQueue.type.push("MANUAL");
                        tableQueue.value.push(0);
                    } else if (customTag !== null && customValue !== null) {
                        tableQueue.type.push(customTag);
                        tableQueue.value.push(customValue);
                    }
                }

                // Push socket id to array for get position in queue
                tableQueue.ids.push(socket.id);
                // Push address to array
                tableQueue.addresses.push(fullAddress);
                // Send to client position in queue
                //config.debug && console.log(fullAddress + " is in queue " + (parseInt(tableQueue.ids.indexOf(socket.id)) + parseInt(1)));
                socket.emit('queuePosition', {position: (parseInt(tableQueue.ids.indexOf(socket.id)) + parseInt(1))});

                db.update("queue", tableQueue);
                tableQueue = null;

                // Respond success
                fn({done: 1});

                // Now update queue position for all users
                sendQueuePosition();
            }
        } else {
            // Respond error
            fn({done:0});
        }
    });
    //When external compute complete PoW, send hash transaction to all clients
    socket.on('newWithdrawalConfirmation', function (data) {
        tableCaches = db.select("caches");
        tableCaches.seeds[seedRound].bundleHash = data.bundle;
        tempCachesBundleHash = data.bundle;
        db.update("caches", tableCaches);

        if(powInProgress){
            config.debug && console.log(new Date().toISOString()+' Success: External computing unit finished PoW');
            config.debug && console.timeEnd('external-pow-time');
        }
        powInProgress = false;
        emitGlobalValues("" ,"bundle");
    });
    socket.on('boostRequest', function () {
        //socket.emit('announcement', "Boost is disabled. Thank you for your help");
        if(db.select("caches").seeds[seedRound].trytes.length !== 0){
        socket.emit("boostAttachToTangle", db.select("caches").seeds[seedRound].trytes, function(confirmation){
            if(confirmation.success == true){
                config.debug && console.log(new Date().toISOString()+ " "+socket.id+' emit attachToTangle to client success');
            } else {
                config.debug && console.log(new Date().toISOString()+ " "+socket.id+' emit attachToTangle to client failed, maybe is disconnected or already do PoW');
            }
        });
        } else {
            socket.emit('announcement', "No unconfirmed transaction for boost. Thank you for your help");
        }
    });
});

// Emit global cache data to connected user
function emitGlobalValues(socket, type){
    var emitData = {};
    switch(String(type)) {
        case "all":
            emitData = {balance: cacheBalance, bundle: tempCachesBundleHash, count: sockets.length, iotaUSD:iotaUSD, totalIotaPerSecond: totalIotaPerSecond, hashIotaRatio: cacheHashIotaratio, confirmedSpams: confirmedSpams};
            break;
        case "balance":
            emitData = {balance: cacheBalance};
            break;
        case "bundle":
            emitData = {bundle: tempCachesBundleHash};
            break;
        case "confirmedSpams":
            emitData = {confirmedSpams: confirmedSpams};
            break;
        case "rates":
            emitData = {count: sockets.length, iotaUSD:iotaUSD, totalIotaPerSecond: totalIotaPerSecond, hashIotaRatio: cacheHashIotaratio};
            break;
    }
    // balance, last bundle, minerr online, hashIotaRatio
    if(socket !== ""){
        socket.emit('globalValues', emitData);
    } else {
        emitToAll('globalValues', emitData);
    }
}
function emitToAll(event, data){
    if(sockets !== undefined) {
        sockets.forEach(function (socketSingle){
            socketSingle.emit(event, data);
        });
    }
}

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('index', { title: 'IOTA Faucet - Get IOTA through mining Monero', iotaProvider:"'"+_currentProvider+"'"});
});

module.exports = router;
