'use strict';
const sha256 = require("sha256");
const uuid = require("uuid/v1");
const BlockFolder = __dirname + '/../BlockFiles/';
const fs = require('fs');
const crypto = require("crypto");
const eccrypto = require("eccrypto");

const EC_GROUP_ORDER = Buffer.from('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 'hex');
const ZERO32 = Buffer.alloc(32, 0);

module.exports = class Blockchain {
    constructor() {
        this.chain = [];
        this.pendingTransactions = [];
        this.pendingWallets = [];
        this.currentNodeUrl = "";
        this.networkNodes = [];
        //GenesisBlock
        this.genesisStatus = false;
        this.genesisTransaction().then(res => {
            console.log("Genesis passed")
        });
    }

    async genesisTransaction() {
        let BlockFiles = fs.readdirSync(BlockFolder).sort();
        if (BlockFiles.length === 0) {
            console.log("Creating Genesis Block");
            this.createNewBlock(100, "0", "0");
        } else {
            let validBlocks = true;
            let lastBlock = null;
            fs.readdirSync(BlockFolder).forEach(file => {
                //TODO Validate manualy last Block + current Block
                const BlockFile = fs.readFileSync(BlockFolder + file).toString();
                const shaBlock = sha256(BlockFile);
                const shaFile = file.split("-");
                if (shaFile[1] === shaBlock) {
                    lastBlock = JSON.parse(BlockFile)
                } else {
                    validBlocks = false
                }
            });
            if (validBlocks) this.chain = lastBlock;
            this.genesisStatus = true;
        }
    }

    saveBlockToFile() {
        const fileName = __dirname + "/../BlockFiles/" + +new Date() + "-" + sha256(JSON.stringify(this.chain));
        fs.appendFileSync(fileName, JSON.stringify(this.chain));
    }


    createNewWallet() {
        // A new random 32-byte private key.
        const privateKey = eccrypto.generatePrivate();
        const privateKeyString = Buffer.from(privateKey).toString("hex");
        // Corresponding uncompressed (65-byte) public key.
        const publicKey = eccrypto.getPublic(privateKey);
        const publicKeyString = Buffer.from(publicKey).toString("hex");
        this.pendingWallets.push(publicKeyString);
        return {privateKey: privateKeyString, publicKey: publicKeyString}
    }

    createNewBlock(nonce, previousBlockHash, hash) {
        const newBlock = {
            index: this.chain.length + 1,
            timestamp: Date.now(),
            transactions: this.pendingTransactions,
            wallets: this.pendingWallets,
            nonce,
            hash,
            previousBlockHash
        };
        this.pendingTransactions = [];
        this.pendingWallets = [];
        this.chain.push(newBlock);
        this.saveBlockToFile();
        return newBlock;
    }

    getLastBlock() {
        return this.chain[this.chain.length - 1]
    }

    isScalar(x) {
        return Buffer.isBuffer(x) && x.length === 32;
    }

    isValidPrivateKey(privateKey) {
        if (!this.isScalar(privateKey)) {
            return false;
        }
        return privateKey.compare(ZERO32) > 0 && // > 0
            privateKey.compare(EC_GROUP_ORDER) < 0; // < G
    }

    walletIsRegistered(wallet) {
        let registered = false;
        this.chain.forEach(chain => {
            if (chain.wallets.indexOf(wallet) !== -1) registered = true;
        });
        return registered
    }

    async createNewTransaction(amount, sender, recipient, message, privateKey) {

        const privateKeyBuffer = Buffer.from(privateKey, "hex");
        let publicKeyBuffer = Buffer.from(sender, "hex");

        const walletIsPending = this.pendingWallets.indexOf(sender) !== -1 || this.pendingWallets.indexOf(recipient) !== -1;
        const walletIsRegistered = this.walletIsRegistered(sender) || this.walletIsRegistered(recipient);
        if (!this.isValidPrivateKey(privateKeyBuffer)) {
            return {error: true, message: "Invalid Private Key"}
        }

        if (!(walletIsPending || walletIsRegistered)) {
            return {error: true, message: "Invalid Wallet from recipient or sender"}
        }

        const senderBalance = this.getAddressData(sender);

        if (senderBalance.addressBalance > 0 || !this.genesisStatus) {
            return new Promise(async function (resolve, reject) {
                const transactions = {
                    amount,
                    sender,
                    recipient,
                    message,
                    timestamp: Date.now()
                };
                const transactionEncoded = crypto.createHash("sha256").update(JSON.stringify(transactions)).digest();
                eccrypto.sign(privateKeyBuffer, transactionEncoded).then(function (sig) {
                    transactions.transactionId = Buffer.from(sig).toString("hex");
                    eccrypto.verify(publicKeyBuffer, transactionEncoded, sig).then(function () {
                        resolve(transactions)
                    }).catch(function (e) {
                        console.log(e);
                        reject({
                            error: true,
                            message: "Can't sign this transaction, verify the the address or the private Key"
                        })
                    });
                });
            });
        } else {
            return {error: true, message: "Sender do not have found for this transactions"}
        }
    }

    addTransactionToPendingTransaction(transactionObj) {
        this.pendingTransactions.push(transactionObj);
        return this.getLastBlock()['index'] + 1
    }

    hashBlock(previousBlockHash, currentBlockData, nonce) {
        const dataAsString = previousBlockHash + nonce.toString() + JSON.stringify(currentBlockData);
        return sha256(dataAsString);
    }

    proofOfWork(previousBlockHash, currentBlockData) {
        let nonce = 0;
        let hash = this.hashBlock(previousBlockHash, currentBlockData, nonce);
        while (hash.substring(0, 4) !== "0000") {
            nonce++;
            hash = this.hashBlock(previousBlockHash, currentBlockData, nonce)
        }
        return nonce;
    }

    chainIsValid(blockchain) {
        let validChain = true;
        if (blockchain && blockchain.length > 0) {
            for (let i = 1; i < blockchain.length; i++) {
                const currentBlock = blockchain[i];
                const prevBlock = blockchain[i - 1];
                const currentBlockData = {
                    transaction: currentBlock.transactions,
                    index: currentBlock.index
                };
                const blockHash = this.hashBlock(prevBlock['hash'], currentBlockData, currentBlock['nonce']);
                if (blockHash.substring(0, 4) !== '0000') validChain = false;
                if (currentBlock['previousBlockHash'] !== prevBlock['hash']) validChain = false;
            }

            const genesisBlock = blockchain[0];
            const correctNonce = genesisBlock['nonce'] === 100;
            const correctPreviousBlockHash = genesisBlock['previousBlockHash'] === '0';
            const correctHash = genesisBlock['hash'] === '0';
            const correctTransactions = genesisBlock['transactions'].length === 0;

            if (!correctNonce || !correctPreviousBlockHash || !correctHash || !correctTransactions) validChain = false;
            return validChain;
        } else {
            return false
        }
    };

    getBlock(blockHash) {
        let correctBlock = null;
        this.chain.forEach(block => {
            if (block.hash === blockHash) correctBlock = block
        });
        return correctBlock
    }

    getTransaction(transactionID) {
        let correctTransaction = null;
        let correctBlock = null;

        this.chain.forEach(block => {
            block.transactions.forEach(transaction => {
                if (transaction.transactionId === transactionID) correctTransaction = transaction;
                if (transaction.transactionId === transactionID) correctBlock = block;
            });
        });
        return {correctTransaction, correctBlock}
    }

    getAddressData(address) {
        const addressTransactions = [];
        this.chain.forEach(block => {
            if (block.transactions) {
                block.transactions.forEach(transaction => {
                    if (transaction.sender === address || transaction.recipient === address) addressTransactions.push(transaction)
                });
            }
        });
        let addressBalance = 0;
        addressTransactions.forEach(transaction => {
            if (transaction.recipient === address) addressBalance += transaction.amount;
            if (transaction.sender === address) addressBalance -= transaction.amount
        });
        return {addressTransactions, addressBalance}
    }
};