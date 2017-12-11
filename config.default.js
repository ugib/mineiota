var config = {
    development: {
        debug: true,
        maintenance: false,
        port: 3000,
        url: 'http://127.0.0.1',
        outputsInBundle: 10,
        reattachAfterMinutes: 10,
        automaticWithdrawal: false,
        skipWithdrawal: false,
        skipAfterMinutes: 60,
        spamming: true,
        externalCompute: false,
        externalComputePassword: 'secretPassword',
        externalOutputsInBundle: 100,
        // Address where to send rest of funds if balance is lower for next payment
        remainingBalanceAddress: '',
        // IOTA Provider details
        iota: {
            host:   'https://yournode.com',
            port:   '14265',
            seeds:  {"seeds":[{"seed":"seed1","keyIndex":0},{"seed":"seed2","keyIndex":0},{"seed":"seed3","keyIndex":0},{"seed":"seed4","keyIndex":0}]}
        },
        // https://coinhive.com details
        coinhive: {
            //Public key is send to users for identify your pool
            publicKey: 'coinHivePublicKeyHere',
            //Private key is used for http api, get info about mining
            privateKey: 'coinHIvePrivateKeyHere',
            // How much percent for client reward
            feeRatio: 10
        }
    },
    production: {
        debug: false,
        maintenance: false,
        port: 3000,
        url: 'https://yourwebsite.com',
        outputsInBundle: 10,
        reattachAfterMinutes: 10,
        automaticWithdrawal: false,
        skipWithdrawal: false,
        skipAfterMinutes: 60,
        spamming: true,
        externalCompute: false,
        externalComputePassword: 'secretPassword',
        externalOutputsInBundle: 100,
        // Address where to send rest of funds if balance is lower for next payment
        remainingBalanceAddress: '',
        // IOTA Provider details
        iota: {
            host:   'https://yournode.com',
            port:   '14265',
            seeds:  {"seeds":[{"seed":"seed1","keyIndex":0},{"seed":"seed2","keyIndex":0},{"seed":"seed3","keyIndex":0},{"seed":"seed4","keyIndex":0}]}
        },
        // https://coinhive.com details
        coinhive: {
            //Public key is send to users for identify your pool
            publicKey: 'coinHivePublicKeyHere',
            //Private key is used for http api, get info about mining
            privateKey: 'coinHIvePrivateKeyHere',
            // How much percent for client reward
            feeRatio: 90
        }
    }
};
module.exports = config;