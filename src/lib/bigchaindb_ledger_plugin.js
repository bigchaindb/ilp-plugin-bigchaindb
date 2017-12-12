// import crypto from 'crypto'
import assert from 'assert'
import reconnectCore from 'reconnect-core'
import EventEmitter2 from 'eventemitter2'
import base58 from 'bs58'
import uuid from 'uuid/v4'

import * as driver from 'bigchaindb-driver' // eslint-disable-line import/no-namespace
import SimpleWebsocket from 'simple-websocket'

class BigchainDBLedgerPlugin extends EventEmitter2 {
    constructor(opts) {
        super()

        this._server = opts.server
        this._ws = opts.ws
        this._keyPair = opts.keyPair
        this._conn = null
        this._connected = false
        this._prefix = 'g.crypto.bigchaindb.'
        this._transfers = {}
        this._notesToSelf = {}
        this._fulfillments = {}

        if (!this._keyPair) {
            throw new Error('missing opts.secret')
        }

        if (!this._server) {
            throw new Error('missing opts.server')
        }

        if (!this._ws) {
            throw new Error('missing opts.ws')
        }
    }

    async connect() {
        this._conn = new driver.Connection(this._server)
        await this._connect()
    }

    _connect() {
        const streamUri = this._ws

        if (this.connection) {
            console.warn('already connected, ignoring connection request')
            return Promise.resolve(null)
        }

        console.log(`subscribing to ${streamUri}`)

        const reconnect = reconnectCore(() => new SimpleWebsocket(streamUri))

        return new Promise((resolve, reject) => {
            this.connection = reconnect({ immediate: true }, (ws) => {
                ws.on('open', () => {
                    console.log(`ws connected to ${streamUri}`)
                })
                ws.on('data', (msg) => {
                    const ev = JSON.parse(msg)
                    console.log(ev)
                    this._handleTransaction(ev)
                })
                ws.on('close', () => {
                    console.log(`ws disconnected from ${streamUri}`)
                })
            })
                .once('connect', () => resolve(null))
                .on('connect', () => {
                    this._connected = true
                    this.emit('connect')
                })
                .on('disconnect', () => {
                    this._connected = false
                    this.emit('disconnect')
                })
                .on('error', (err) => {
                    console.warn(`ws error on ${streamUri}:  ${err}`)
                    reject(err)
                })
                .connect()
        })
    }

    disconnect() {
        if (this.connection) {
            this.connection.disconnect()
            this.connection = null
        }
    }

    isConnected() {
        return this._connected
    }

    getInfo() {
        return {
            prefix: this._prefix,
            precision: 10,
            scale: 4
        }
    }

    getAccount() {
        return this._prefix + this._keyPair.publicKey
    }

    async getBalance() {
        const unspentTransactions = await this._getUnspentTransactions()
        return unspentTransactions
            .map((transaction) => transaction.outputs
                .map((output) => parseInt(output.amount, 10))
                .reduce((prevVal, elem) => prevVal + elem, 0))
            .reduce((prevVal, elem) => prevVal + elem, 0)
    }

    async _getUnspentTransactions() {
        const outputs = await this._getUnspentOutputs()
        const unspentTransactions = await Promise.all(outputs.map(async (output) =>
            await this._getTransactionForOutput(output))) // eslint-disable-line no-return-await

        return unspentTransactions
            .filter(transaction =>
                !!transaction.metadata &&
                !!transaction.metadata.type &&
                (
                    transaction.metadata.type === 'ilp:coin' ||
                    transaction.metadata.type === 'ilp:fulfill' ||
                    transaction.metadata.type.hasOwnProperty('ilp:coin') ||
                    transaction.metadata.type.hasOwnProperty('ilp:fulfill')
                ) &&
                transaction.outputs[0].public_keys.length === 1)
    }

    async _getUnspentOutputs() {
        const { publicKey } = this._keyPair

        return await this._conn.listOutputs(publicKey, false) // eslint-disable-line no-return-await
            .then(res => res)
    }

    async _getTransactionForOutput(output) {
        const txId = output.transaction_id
        return await this._conn.getTransaction(txId) // eslint-disable-line no-return-await
            .then((tx) => tx)
    }

    async sendTransfer(transfer) {
        const [, localAddress] = transfer.to.match(/^g\.crypto\.bigchaindb\.(.+)/)
        const amount = transfer.amount // eslint-disable-line prefer-destructuring
        // TODO: is there a better way to do note to self?
        this._notesToSelf[transfer.id] = JSON.parse(JSON.stringify(transfer.noteToSelf))

        console.log(
            'sending', amount.toString(), 'to', localAddress,
            'condition', transfer.executionCondition
        )

        const unspentTransactions = await this._getUnspentTransactions()

        assert(unspentTransactions.length > 0)
        const inputTransaction = unspentTransactions[0]
        const inputAmount = inputTransaction.outputs[0].amount

        const subconditionExecute = driver.Transaction.makeEd25519Condition(this._keyPair.publicKey, false) // eslint-disable-line max-len
        const subconditionAbort = driver.Transaction.makeEd25519Condition(localAddress, false)

        const condition = driver.Transaction.makeThresholdCondition(
            1,
            [subconditionExecute, subconditionAbort]
        )

        const output = driver.Transaction.makeOutput(condition, amount.toString())
        output.public_keys = [this._keyPair.publicKey, localAddress]

        const conditionChange = driver.Transaction.makeEd25519Condition(this._keyPair.publicKey)

        const outputs = [output]

        const changeAmount = parseInt(inputAmount, 10) - amount
        if (changeAmount > 0) {
            outputs.push(driver.Transaction.makeOutput(conditionChange, changeAmount.toString()))
        }

        const metadata = {
            type: {
                'ilp:escrow': {
                    id: transfer.id,
                    ilp: transfer.ilp,
                    noteToSelf: transfer.noteToSelf,
                    executionCondition: transfer.executionCondition,
                    expiresAt: transfer.expiresAt,
                    custom: transfer.custom
                }
            }
        }

        const tx = driver.Transaction.makeTransferTransaction(
            inputTransaction,
            metadata,
            outputs,
            0
        )

        const txSigned =
            driver.Transaction.signTransaction(tx, this._keyPair.privateKey)

        console.log('signing and submitting transaction', txSigned)
        console.log('transaction id of', transfer.id, 'is', txSigned.id)

        await this._conn
            .postTransaction(txSigned)
            .then((res) => {
                console.log('Response from BDB server', res)
                return this._conn
                    .pollStatusAndFetchTransaction(txSigned.id)
            })
        console.log('completed transaction')
        console.log('setting up expiry')
        // this._setupExpiry(transfer.id, transfer.expiresAt)
    }

    async fulfillCondition(transferId, fulfillment) {
        assert(this._connected, 'plugin must be connected before fulfillCondition')
        console.log('preparing to fulfill condition', transferId)

        const cached = this._transfers[transferId]
        if (!cached) {
            throw new Error(`no transfer with id ${transferId}`)
        }

        // const condition = crypto
        //     .createHash('sha256')
        //     .update(Buffer.from(fulfillment, 'base64'))
        //     .digest()
        //     .toString('base64')

        const { publicKey, privateKey } = this._keyPair

        const outputCondition = driver.Transaction.makeEd25519Condition(publicKey)

        const output = driver.Transaction.makeOutput(outputCondition, cached.outputs[0].amount)

        const metadata = {
            type: {
                'ilp:fulfill': {
                    id: uuid(),
                    fulfillment
                }
            }
        }

        const tx = driver.Transaction.makeTransferTransaction(
            cached,
            metadata,
            [output],
            0
        )

        const txFulfillment = driver.Transaction.makeThresholdCondition(1, undefined, false)

        const sourceKey = getSource(this, cached)
        const abortCondition = driver.Transaction.makeEd25519Condition(sourceKey, false)
        txFulfillment.addSubconditionUri(abortCondition.getConditionUri())

        const executeFulfillment = driver.Transaction.makeEd25519Condition(publicKey, false)
        executeFulfillment.sign(
            Buffer.from(driver.Transaction.serializeTransactionIntoCanonicalString(tx)),
            Buffer.from(base58.decode(privateKey))
        )
        txFulfillment.addSubfulfillment(executeFulfillment)

        // TODO: add fulfillment to threshold (2-2 [fulfillment, 1-2 [execute, abort])

        tx.inputs[0].fulfillment = txFulfillment.serializeUri()

        console.log(`signing and submitting transaction: ${tx}`)

        await this._conn
            .postTransaction(tx)
            .then((res) => {
                console.log('Response from BDB server', res)
                return this._conn
                    .pollStatusAndFetchTransaction(tx.id)
            })

        console.log('completed fulfill transaction')
    }

    _setupExpiry(transferId, expiresAt) {
        const that = this
        // TODO: this is a bit of an unsafe hack, but if the time is not adjusted
        // like this, the cancel transaction fails.
        const delay = (new Date(expiresAt)) - (new Date()) + 5000

        setTimeout(
            that._expireTransfer.bind(that, transferId),
            delay
        )
    }

    // async _expireTransfer(transferId) {
    //     if (this._transfers[transferId].Done) return
    //     debug('preparing to cancel transfer at', new Date().toISOString())
    //
    //     // make sure that the promise rejection is handled no matter
    //     // which step it happens during.
    //     try {
    //         const cached = this._transfers[transferId]
    //         const tx = await this._api.prepareEscrowCancellation(this._address, {
    //             owner: cached.Account,
    //             escrowSequence: cached.Sequence
    //         })
    //
    //         const signed = this._api.sign(tx.txJSON, this._secret)
    //         debug(`signing and submitting transaction: ${tx.txJSON}`)
    //         debug('cancel tx id of', transferId, 'is', signed.id)
    //
    //         await Submitter.submit(this._api, signed)
    //         debug('completed cancel transaction')
    //     } catch (e) {
    //         debug('CANCELLATION FAILURE! error was:', e.message)
    //
    //         // just retry if it was a ledger thing
    //         // TODO: is there any other scenario to retry under?
    //         if (e.name !== 'NotAcceptedError') return
    //
    //         debug(`CANCELLATION FAILURE! (${transferId}) retrying...`)
    //         await this._expireTransfer(transferId)
    //     }
    // }

    async _handleTransaction(changes) {
        // yield this.emitAsync('incoming', changes);
        // const {publicKey} = this._keyPair;
        const transaction = await this._conn.getTransaction(changes.transaction_id)
        const direction = getDirection(this, transaction)

        if (transaction) {
            const transfer = transactionToTransfer(this, transaction)
            this._transfers[transfer.id] = transaction
            console.log('received', transaction.metadata.type)
            if (transaction.metadata.type.hasOwnProperty('ilp:escrow')) {
                console.log('handle', transaction.id, `${direction}_prepare`, this._keyPair.publicKey)
                this.emitAsync(`${direction}_prepare`, transfer, transaction)
            } else if (transaction.metadata.type.hasOwnProperty('ilp:fulfill')) {
                const fulfillment = transaction.metadata.type['ilp:fulfill'].fulfillment // eslint-disable-line prefer-destructuring
                console.log('handle', transaction.id, `${direction}_fulfill`, this._keyPair.publicKey)
                this.emitAsync(`${direction}_fulfill`, transfer, fulfillment)
            } else if (transaction.metadata.type.hasOwnProperty('ilp:cancel')) {
                console.log('handle', transaction.id, `${direction}_cancel`, this._keyPair.publicKey)
                this.emitAsync(`${direction}_cancel`, transfer)
            }
        }
        // } else if (transaction.TransactionType === 'Payment') {
        //   const message = Translate.paymentToMessage(this, ev)
        //   this.emitAsync(message.direction + '_message', message)
        // }
    }
}

export default BigchainDBLedgerPlugin


function transactionToTransfer(plugin, transaction) {
    const metadata = transaction.metadata.type['ilp:escrow'] ||
        transaction.metadata.type['ilp:fulfill']
    return {
        id: metadata.id,
        to: plugin._prefix + getDestination(plugin, transaction),
        from: plugin._prefix + getSource(plugin, transaction),
        direction: getDirection(plugin, transaction),
        ledger: plugin._prefix,
        amount: getAmount(plugin, transaction),
        ilp: metadata.ilp,
        executionCondition: metadata.executionCondition,
        noteToSelf: metadata.noteToSelf,
        expiresAt: metadata.expiresAt
    }
}

function getDirection(plugin, transaction) {
    const { publicKey } = plugin._keyPair
    const metadata = transaction.metadata.type
    if (metadata.hasOwnProperty('ilp:escrow')) {
        if (transaction.inputs[0].owners_before.indexOf(publicKey) > -1) {
            return 'outgoing'
        }
        if (transaction.outputs[0].public_keys.indexOf(publicKey) > -1) {
            return 'incoming'
        }
    } else {
        if (transaction.outputs[0].public_keys.indexOf(publicKey) > -1) {
            return 'incoming'
        }
        if (transaction.inputs[0].owners_before.indexOf(publicKey) > -1) {
            return 'outgoing'
        }
    }
    return null
}

function getSource(plugin, transaction) {
    // TODO: include all inputs
    const inputKeys = transaction.inputs[0].owners_before
    return inputKeys[0]
}

function getDestination(plugin, transaction) {
    // TODO: include all outputs
    const outputKeys = transaction.outputs[0].public_keys
    const { publicKey } = plugin._keyPair
    return _selectPublicKey(outputKeys, publicKey)
}

function _selectPublicKey(keyList, keyBlackList) {
    assert(keyList.length <= 2)
    if (keyList.length === 1) {
        return keyList[0]
    }
    if (keyList.length > 1) {
        const selectedKeys = keyList
            .filter((outputKey) => outputKey !== keyBlackList)
        assert(selectedKeys.length > 0)
        return selectedKeys[0]
    }
    return null
}

function getAmount(plugin, transaction) {
    const { publicKey } = plugin._keyPair
    return transaction.outputs
        .filter((output) => output.public_keys.indexOf(publicKey) === 0)
        .map((output) => parseInt(output.amount, 10))
        .reduce((prevVal, elem) => prevVal + elem, 0)
}
