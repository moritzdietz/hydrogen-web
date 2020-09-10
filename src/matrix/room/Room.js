/*
Copyright 2020 Bruno Windels <bruno@windels.cloud>

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {EventEmitter} from "../../utils/EventEmitter.js";
import {RoomSummary, needsHeroes} from "./RoomSummary.js";
import {SyncWriter} from "./timeline/persistence/SyncWriter.js";
import {GapWriter} from "./timeline/persistence/GapWriter.js";
import {Timeline} from "./timeline/Timeline.js";
import {FragmentIdComparer} from "./timeline/FragmentIdComparer.js";
import {SendQueue} from "./sending/SendQueue.js";
import {WrappedError} from "../error.js"
import {fetchOrLoadMembers} from "./members/load.js";
import {MemberList} from "./members/MemberList.js";
import {Heroes} from "./members/Heroes.js";
import {EventEntry} from "./timeline/entries/EventEntry.js";
import {DecryptionSource} from "../e2ee/common.js";

const EVENT_ENCRYPTED_TYPE = "m.room.encrypted";

export class Room extends EventEmitter {
	constructor({roomId, storage, hsApi, emitCollectionChange, sendScheduler, pendingEvents, user, createRoomEncryption, getSyncToken}) {
        super();
        this._roomId = roomId;
        this._storage = storage;
        this._hsApi = hsApi;
		this._summary = new RoomSummary(roomId, user.id);
        this._fragmentIdComparer = new FragmentIdComparer([]);
		this._syncWriter = new SyncWriter({roomId, fragmentIdComparer: this._fragmentIdComparer});
        this._emitCollectionChange = emitCollectionChange;
        this._sendQueue = new SendQueue({roomId, storage, sendScheduler, pendingEvents});
        this._timeline = null;
        this._user = user;
        this._changedMembersDuringSync = null;
        this._memberList = null;
        this._createRoomEncryption = createRoomEncryption;
        this._roomEncryption = null;
        this._getSyncToken = getSyncToken;
	}

    async notifyRoomKeys(roomKeys) {
        if (this._roomEncryption) {
            let retryEventIds = this._roomEncryption.applyRoomKeys(roomKeys);
            if (retryEventIds.length) {
                const retryEntries = [];
                const txn = await this._storage.readTxn([
                    this._storage.storeNames.timelineEvents,
                    this._storage.storeNames.inboundGroupSessions,
                ]);
                for (const eventId of retryEventIds) {
                    const storageEntry = await txn.timelineEvents.getByEventId(this._roomId, eventId);
                    if (storageEntry) {
                        retryEntries.push(new EventEntry(storageEntry, this._fragmentIdComparer));
                    }
                }
                await this._decryptEntries(DecryptionSource.Retry, retryEntries, txn);
                if (this._timeline) {
                    // only adds if already present
                    this._timeline.replaceEntries(retryEntries);
                }
                // pass decryptedEntries to roomSummary
            }
        }
    }

    _enableEncryption(encryptionParams) {
        this._roomEncryption = this._createRoomEncryption(this, encryptionParams);
        if (this._roomEncryption) {
            this._sendQueue.enableEncryption(this._roomEncryption);
            if (this._timeline) {
                this._timeline.enableEncryption(this._decryptEntries.bind(this, DecryptionSource.Timeline));
            }
        }
    }

    /**
     * Used for decrypting when loading/filling the timeline, and retrying decryption,
     * not during sync, where it is split up during the multiple phases.
     */
    async _decryptEntries(source, entries, inboundSessionTxn = null) {
        if (!inboundSessionTxn) {
            inboundSessionTxn = await this._storage.readTxn([this._storage.storeNames.inboundGroupSessions]);
        }
        const events = entries.filter(entry => {
            return entry.eventType === EVENT_ENCRYPTED_TYPE;
        }).map(entry => entry.event);
        const isTimelineOpen = this._isTimelineOpen;
        const preparation = await this._roomEncryption.prepareDecryptAll(events, source, isTimelineOpen, inboundSessionTxn);
        const changes = await preparation.decrypt();
        const stores = [this._storage.storeNames.groupSessionDecryptions];
        if (isTimelineOpen) {
            // read to fetch devices if timeline is open
            stores.push(this._storage.storeNames.deviceIdentities);
        }
        const writeTxn = await this._storage.readWriteTxn(stores);
        let decryption;
        try {
            decryption = await changes.write(writeTxn);
        } catch (err) {
            writeTxn.abort();
            throw err;
        }
        await writeTxn.complete();
        decryption.applyToEntries(entries);
    }

            }
        }
        return entry;
    }

    async _decryptEntries(entries, txn, isSync = false) {
        return await Promise.all(entries.map(async e => this._decryptEntry(e, txn, isSync)));
    }

    /** @package */
    async writeSync(roomResponse, membership, isInitialSync, txn) {
        const isTimelineOpen = !!this._timeline;
		const summaryChanges = this._summary.writeSync(
            roomResponse,
            membership,
            isInitialSync, isTimelineOpen,
            txn);
		const {entries: encryptedEntries, newLiveKey, memberChanges} =
            await this._syncWriter.writeSync(roomResponse, this.isTrackingMembers, txn);
        // decrypt if applicable
        let entries = encryptedEntries;
        if (this._roomEncryption) {
            entries = await this._decryptEntries(encryptedEntries, txn, true);
        }
        // fetch new members while we have txn open,
        // but don't make any in-memory changes yet
        let heroChanges;
        if (needsHeroes(summaryChanges)) {
            // room name disappeared, open heroes
            if (!this._heroes) {
                this._heroes = new Heroes(this._roomId);
            }
            heroChanges = await this._heroes.calculateChanges(summaryChanges.heroes, memberChanges, txn);
        }
        // pass member changes to device tracker
        if (this._roomEncryption && this.isTrackingMembers && memberChanges?.size) {
            await this._roomEncryption.writeMemberChanges(memberChanges, txn);
        }
        let removedPendingEvents;
        if (roomResponse.timeline && roomResponse.timeline.events) {
            removedPendingEvents = this._sendQueue.removeRemoteEchos(roomResponse.timeline.events, txn);
        }
        return {
            summaryChanges,
            newTimelineEntries: entries,
            newLiveKey,
            removedPendingEvents,
            memberChanges,
            heroChanges,
            needsAfterSyncCompleted: this._roomEncryption?.needsToShareKeys(memberChanges)
        };
    }

    /**
     * @package
     * Called with the changes returned from `writeSync` to apply them and emit changes.
     * No storage or network operations should be done here.
     */
    afterSync({summaryChanges, newTimelineEntries, newLiveKey, removedPendingEvents, memberChanges, heroChanges}) {
        this._syncWriter.afterSync(newLiveKey);
        if (!this._summary.encryption && summaryChanges.encryption && !this._roomEncryption) {
            this._enableEncryption(summaryChanges.encryption);
        }
        if (memberChanges.size) {
            if (this._changedMembersDuringSync) {
                for (const [userId, memberChange] of memberChanges.entries()) {
                    this._changedMembersDuringSync.set(userId, memberChange.member);
                }
            }
            if (this._memberList) {
                this._memberList.afterSync(memberChanges);
            }
        }
        let emitChange = false;
        if (summaryChanges) {
            this._summary.applyChanges(summaryChanges);
            if (!this._summary.needsHeroes) {
                this._heroes = null;
            }
            emitChange = true;
        }
        if (this._heroes && heroChanges) {
            const oldName = this.name;
            this._heroes.applyChanges(heroChanges, this._summary);
            if (oldName !== this.name) {
                emitChange = true;
            }
        }
        if (emitChange) {
            this.emit("change");
            this._emitCollectionChange(this);
        }
        if (this._timeline) {
            this._timeline.appendLiveEntries(newTimelineEntries);
        }
        if (removedPendingEvents) {
            this._sendQueue.emitRemovals(removedPendingEvents);
        }
	}

    /**
     * Only called if the result of writeSync had `needsAfterSyncCompleted` set.
     * Can be used to do longer running operations that resulted from the last sync,
     * like network operations.
     */
    async afterSyncCompleted({memberChanges}) {
        if (this._roomEncryption) {
            await this._roomEncryption.shareRoomKeyForMemberChanges(memberChanges, this._hsApi);
        }
    }

    /** @package */
    async start() {
        if (this._roomEncryption) {
            try {
                // if we got interrupted last time sending keys to newly joined members
                await this._roomEncryption.shareRoomKeyToPendingMembers(this._hsApi);
            } catch (err) {
                // we should not throw here
                console.error(`could not send out pending room keys for room ${this.id}`, err.stack);
            }
        }
        this._sendQueue.resumeSending();
    }

    /** @package */
	async load(summary, txn) {
        try {
            this._summary.load(summary);
            if (this._summary.encryption) {
                this._enableEncryption(this._summary.encryption);
            }
            // need to load members for name?
            if (this._summary.needsHeroes) {
                this._heroes = new Heroes(this._roomId);
                const changes = await this._heroes.calculateChanges(this._summary.heroes, [], txn);
                this._heroes.applyChanges(changes, this._summary);
            }
            return this._syncWriter.load(txn);
        } catch (err) {
            throw new WrappedError(`Could not load room ${this._roomId}`, err);
        }
	}

    /** @public */
    sendEvent(eventType, content) {
        return this._sendQueue.enqueueEvent(eventType, content);
    }

    /** @public */
    async loadMemberList() {
        if (this._memberList) {
            // TODO: also await fetchOrLoadMembers promise here
            this._memberList.retain();
            return this._memberList;
        } else {
            const members = await fetchOrLoadMembers({
                summary: this._summary,
                roomId: this._roomId,
                hsApi: this._hsApi,
                storage: this._storage,
                syncToken: this._getSyncToken(),
                // to handle race between /members and /sync
                setChangedMembersMap: map => this._changedMembersDuringSync = map,
            });
            this._memberList = new MemberList({
                members,
                closeCallback: () => { this._memberList = null; }
            });
            return this._memberList;
        }
    } 

    /** @public */
    async fillGap(fragmentEntry, amount) {
        // TODO move some/all of this out of Room
        if (fragmentEntry.edgeReached) {
            return;
        }
        const response = await this._hsApi.messages(this._roomId, {
            from: fragmentEntry.token,
            dir: fragmentEntry.direction.asApiString(),
            limit: amount,
            filter: {
                lazy_load_members: true,
                include_redundant_members: true,
            }
        }).response();

        const txn = await this._storage.readWriteTxn([
            this._storage.storeNames.pendingEvents,
            this._storage.storeNames.timelineEvents,
            this._storage.storeNames.timelineFragments,
        ]);
        let removedPendingEvents;
        let gapResult;
        try {
            // detect remote echos of pending messages in the gap
            removedPendingEvents = this._sendQueue.removeRemoteEchos(response.chunk, txn);
            // write new events into gap
            const gapWriter = new GapWriter({
                roomId: this._roomId,
                storage: this._storage,
                fragmentIdComparer: this._fragmentIdComparer,
            });
            gapResult = await gapWriter.writeFragmentFill(fragmentEntry, response, txn);
        } catch (err) {
            txn.abort();
            throw err;
        }
        await txn.complete();
        if (this._roomEncryption) {
            await this._decryptEntries(DecryptionSource.Timeline, gapResult.entries);
        }
        // once txn is committed, update in-memory state & emit events
        for (const fragment of gapResult.fragments) {
            this._fragmentIdComparer.add(fragment);
        }
        if (removedPendingEvents) {
            this._sendQueue.emitRemovals(removedPendingEvents);
        }
        if (this._timeline) {
            this._timeline.addGapEntries(gapResult.entries);
        }
    }

    /** @public */
    get name() {
        if (this._heroes) {
            return this._heroes.roomName;
        }
        return this._summary.name;
    }

    /** @public */
    get id() {
        return this._roomId;
    }

    get avatarUrl() {
        if (this._summary.avatarUrl) {
            return this._summary.avatarUrl;
        } else if (this._heroes) {
            return this._heroes.roomAvatarUrl;
        }
        return null;
    }

    get lastMessageTimestamp() {
        return this._summary.lastMessageTimestamp;
    }

    get isUnread() {
        return this._summary.isUnread;
    }

    get notificationCount() {
        return this._summary.notificationCount;
    }
    
    get highlightCount() {
        return this._summary.highlightCount;
    }

    get isLowPriority() {
        const tags = this._summary.tags;
        return !!(tags && tags['m.lowpriority']);
    }

    get isEncrypted() {
        return !!this._summary.encryption;
    }

    get isTrackingMembers() {
        return this._summary.isTrackingMembers;
    }

    async _getLastEventId() {
        const lastKey = this._syncWriter.lastMessageKey;
        if (lastKey) {
            const txn = await this._storage.readTxn([
                this._storage.storeNames.timelineEvents,
            ]);
            const eventEntry = await txn.timelineEvents.get(this._roomId, lastKey);
            return eventEntry?.event?.event_id;
        }
    }

    get _isTimelineOpen() {
        return !!this._timeline;
    }

    async clearUnread() {
        if (this.isUnread || this.notificationCount) {
            const txn = await this._storage.readWriteTxn([
                this._storage.storeNames.roomSummary,
            ]);
            let data;
            try {
                data = this._summary.writeClearUnread(txn);
            } catch (err) {
                txn.abort();
                throw err;
            }
            await txn.complete();
            this._summary.applyChanges(data);
            this.emit("change");
            this._emitCollectionChange(this);
            
            try {
                const lastEventId = await this._getLastEventId();
                if (lastEventId) {
                    await this._hsApi.receipt(this._roomId, "m.read", lastEventId);
                }
            } catch (err) {
                // ignore ConnectionError
                if (err.name !== "ConnectionError") {
                    throw err;
                }
            }
        }
    }

    /** @public */
    async openTimeline() {
        if (this._timeline) {
            throw new Error("not dealing with load race here for now");
        }
        console.log(`opening the timeline for ${this._roomId}`);
        this._timeline = new Timeline({
            roomId: this.id,
            storage: this._storage,
            fragmentIdComparer: this._fragmentIdComparer,
            pendingEvents: this._sendQueue.pendingEvents,
            closeCallback: () => {
                console.log(`closing the timeline for ${this._roomId}`);
                this._timeline = null;
                if (this._roomEncryption) {
                    this._roomEncryption.notifyTimelineClosed();
                }
            },
            user: this._user,
        });
        if (this._roomEncryption) {
            this._timeline.enableEncryption(this._decryptEntries.bind(this, DecryptionSource.Timeline));
        }
        await this._timeline.load();
        return this._timeline;
    }

    get mediaRepository() {
        return this._hsApi.mediaRepository;
    }

    /** @package */
    writeIsTrackingMembers(value, txn) {
        return this._summary.writeIsTrackingMembers(value, txn);
    }

    /** @package */
    applyIsTrackingMembersChanges(changes) {
        this._summary.applyChanges(changes);
    }
}

