import co from 'co';
import reconnectCore from 'reconnect-core';
import EventEmitter2 from 'eventemitter2';
import SimpleWebsocket from 'simple-websocket';
import moment from 'moment';
import { parseEscrowData, filterByType, TypeIds } from 'cryptoconditions-utils';

import request from '../util/request';


class BigchainDBLedgerPlugin extends EventEmitter2 {

    constructor(options) {
        super();

        this.id = options.auth.ledgerId;
        this.credentials = options.auth;
        this.config = options.config;

        this.connection = null;
        this.connected = false;
    }

    connect() {
        return co(this._connect.bind(this));
    }

    * _connect() {
        const wsUri = this.credentials.account.uri.ws;

        if (this.connection) {
            console.warn('already connected, ignoring connection request');
            return Promise.resolve(null);
        }

        const streamUri = `${wsUri}/users/${this.credentials.account.id}/changes`;
        console.log(`subscribing to ${streamUri}`);

        const reconnect = reconnectCore(() => new SimpleWebsocket(streamUri));

        return new Promise((resolve, reject) => {
            this.connection = reconnect({immediate: true}, (ws) => {
                ws.on('open', () => {
                    console.log(`ws connected to ${streamUri}`);
                });
                ws.on('data', (msg) => {
                    const notification = JSON.parse(msg);
                    co.wrap(this._handleNotification)
                        .call(this, notification)
                        .catch((err) => {
                            console.error(err);
                        });
                });
                ws.on('close', () => {
                    console.log(`ws disconnected from ${streamUri}`);
                });
            })
                .once('connect', () => resolve(null))
                .on('connect', () => {
                    this.connected = true;
                    this.emit('connect');
                })
                .on('disconnect', () => {
                    this.connected = false;
                    this.emit('disconnect');
                })
                .on('error', (err) => {
                    console.warn(`ws error on ${streamUri}:  ${err}`);
                    reject(err);
                })
                .connect();
        });
    }

    disconnect() {
        if (this.connection) {
            this.connection.disconnect();
            this.connection = null;
        }
    }

    isConnected() {
        return this.connected;
    }

    getInfo() {
        return co.wrap(this._getInfo).call(this);
    }

    * _getInfo() {
        console.log('getInfo', this.id);
        return {
            precision: 10,
            scale: 4
        };
    }

    getAccount() {
        return this.credentials.account;
    }

    getBalance() {
        return co.wrap(this._getAssetList)
            .call(this)
            .then((res) => res.length);
    }

    getAssetList() {
        return co.wrap(this._getAssetList).call(this);
    }

    * _getAssetList() {
        const {
            account
        } = this.credentials;

        let res;

        try {
            res = yield request(`${account.uri.api}/api/accounts/${account.id}/assets/`, {
                method: 'GET',
                query: {
                    app: 'interledger'
                }
            });
        } catch (e) {
            console.error(e);
            throw new Error('Unable to retrieve asset list');
        }

        if (res && res.assets && res.assets.bigchain && Array.isArray(res.assets.bigchain)) {
            return res.assets.bigchain;
        } else {
            throw new Error('Unable to retrieve asset list');
        }
    }

    getAsset(id) {
        return co.wrap(this._getAsset).call(this, id);
    }

    * _getAsset(id) {
        const {
            account
        } = this.credentials;

        let res;
        console.log('_getAsset', id)
        try {
            res = yield request(`${account.uri.api}/api/assets/${id}/`, {
                method: 'GET'
            });
        } catch (e) {
            console.error(e);
            throw new Error('Unable to retrieve asset');
        }

        return res;
    }

    getConnectors() {
        return co.wrap(this._getConnectors).call(this);
    }

    * _getConnectors() {
        if (this.id == null) {
            throw new Error('Must be connected before getConnectors can be called');
        }

        const {
            account
        } = this.credentials;

        let res;
        try {
            res = yield request(`${account.uri.api}/api/connectors/`, {
                method: 'GET',
                query: {
                    app: 'interledger'
                }
            });
        } catch (e) {
            console.error(e);
            throw new Error('Unable to get connectors');
        }
        return res;
    }

    /*
     Initiates a ledger-local transfer.
     */
    send(transfer) {
        return co.wrap(this._send).call(this, transfer);
    }

    * _send(transfer) {
        const sentTransfers = [];
        if ('asset' in transfer) {
            sentTransfers.push(yield this._sendAsset(transfer.asset, transfer));
        } else if (transfer.amount) {
            const numAssetsToTransfer = Math.ceil(transfer.amount);
            const assetList = yield this.getAssetList();
            for (let i = 0; i < numAssetsToTransfer; i++) {
                const asset = {
                    txid: assetList[i].id,
                    cid: 0
                };
                sentTransfers.push(yield this._sendAsset(asset, transfer));
            }
        }
        return sentTransfers;
    }

    * _sendAsset(asset, transfer) {
        console.log('sending asset', transfer)

        const {
            account
        } = this.credentials;

        const {
            txid,
            cid
        } = asset;
        let res;
        try {
            let ilpHeader;
            if (transfer.data && transfer.data.ilp_header) {
                ilpHeader = transfer.data.ilp_header;
            } else {
                ilpHeader = {
                    account: transfer.destinationAccount.vk,
                    ledger: transfer.destinationAccount.ledger.id
                };
            }

            if (ilpHeader && transfer.noteToSelf) {
                ilpHeader.noteToSelf = transfer.noteToSelf;
            }

            let to;
            if (transfer.account) {
                if (transfer.account.vk) {
                    to = transfer.account;
                } else {
                    to = {
                        vk: transfer.account
                    };
                }
            }

            let expiresAt = transfer.expiresAt;
            if (typeof(expiresAt) === 'string') {
                expiresAt = moment(expiresAt).unix();
            }

            res = yield request(`${account.uri.api}/api/assets/${txid}/${cid}/escrow/`, {
                method: 'POST',
                jsonBody: {
                    source: {
                        vk: account.id,
                        sk: account.key
                    },
                    to,
                    ilpHeader,
                    executionCondition: transfer.executionCondition,
                    expiresAt
                }
            });
        } catch (e) {
            console.error(e);
            throw new Error('Unable to escrow transfer');
        }
        return res;
    }

    fulfillCondition(transferID, conditionFulfillment) {
        if (typeof(transferID) === 'string') {
            return co.wrap(this._getAsset)
                .call(this, transferID)
                .then((transfer) => {
                    const cid = 0;
                    const {
                        abortCondition,
                        executeCondition
                    } = parseEscrowData(transfer.transaction.conditions[cid].condition.details);
                    return co.wrap(this._fulfillCondition).call(this, {
                        account: {
                            vk: executeCondition.public_key
                        },
                        asset: {
                            txid: transfer.id,
                            cid
                        },
                    }, conditionFulfillment);
                });
        } else {
            return co.wrap(this._fulfillCondition).call(this, transferID, conditionFulfillment)
        }
    }

    * _fulfillCondition(transfer, conditionFulfillment) {
        let res;

        const {
            account
        } = this.credentials;

        const {
            txid,
            cid
        } = transfer.asset;

        try {
            res = yield request(`${account.uri.api}/api/assets/${txid}/${cid}/escrow/fulfill/`, {
                method: 'POST',
                jsonBody: {
                    source: {
                        vk: account.id,
                        sk: account.key
                    },
                    to: transfer.account,
                    conditionFulfillment
                }
            });
        } catch (e) {
            throw new Error('Unable to escrow transfer');
        }
        return 'executed';
    }

    replyToTransfer() {
    }

    * _handleNotification(changes) {
        yield this.emitAsync('incoming', changes);
        const { account } = this.credentials;

        if (changes.message === 'bigchain_voted_block') {
            const tx = changes.transaction.transaction;
            for (const condition of tx.conditions) {
                const {
                    abortCondition,
                    executeCondition,
                    expiryTime
                } = parseEscrowData(condition.condition.details);

                const ed25519Conditions = filterByType({
                    condition: condition.condition.details,
                    typeId: TypeIds.ed25519
                });

                let noteToSelf = {};
                if (tx.data.payload.ilp_header) {
                    noteToSelf = tx.data.payload.ilp_header.noteToSelf;
                    delete tx.data.payload.ilp_header.noteToSelf;
                }

                const transfer = {
                    id: `${changes.transaction.id}`,
                    amount: '1.0',
                    data: tx.data.payload,
                    executionCondition: 'cc:0:3:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU:0',
                    // cancellationCondition: fiveBellsTransfer.cancellation_condition,
                    expiresAt: moment(expiryTime * 1000).utc().format()
                };

                if (executeCondition &&
                    executeCondition.public_key === account.id &&
                    abortCondition &&
                    abortCondition.public_key) {
                    transfer.direction = 'incoming';
                    transfer.account = `${account.uri.api}/api/accounts/${abortCondition.public_key}`;
                    yield this.emitAsync('receive', transfer);
                } else if (ed25519Conditions && ed25519Conditions.length) {
                    transfer.direction = 'outgoing';
                    transfer.account = `${account.uri.api}/api/accounts/${ed25519Conditions[0].public_key}`;
                    transfer.noteToSelf = noteToSelf;
                    yield this.emitAsync('fulfill_execution_condition', transfer, 'cf:0:');
                }
            }
        }
    }
}

export default BigchainDBLedgerPlugin;
