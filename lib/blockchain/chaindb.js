/*!
 * chaindb.js - blockchain data management for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const bdb = require('bdb');
const bio = require('bufio');
const blake2b = require('bcrypto/lib/blake2b');
const LRU = require('blru');
const {Tree} = require('urkel');
const {BufferMap, BufferSet} = require('buffer-map');
const ChainMigrator = require('./migrations');
const Amount = require('../ui/amount');
const CoinView = require('../coins/coinview');
const UndoCoins = require('../coins/undocoins');
const consensus = require('../protocol/consensus');
const Block = require('../primitives/block');
const Outpoint = require('../primitives/outpoint');
const Address = require('../primitives/address');
const ChainEntry = require('./chainentry');
const TXMeta = require('../primitives/txmeta');
const CoinEntry = require('../coins/coinentry');
const rules = require('../covenants/rules');
const NameState = require('../covenants/namestate');
const NameUndo = require('../covenants/undo');
const {BitField} = require('../covenants/bitfield');
const {types} = rules;
const layout = require('./layout');
const {
  TreeState,
  StateCache,
  ChainState,
  ChainFlags
} = require('./records');

/** @typedef {import('urkel').Proof} Proof */
/** @typedef {ReturnType<bdb.DB['batch']>} Batch */
/** @typedef {import('bfilter').BloomFilter} BloomFilter */
/** @typedef {import('../types').Hash} Hash */
/** @typedef {import('./chain').ChainOptions} ChainOptions */
/** @typedef {import('../primitives/tx')} TX */
/** @typedef {import('../primitives/coin')} Coin */

/**
 * ChainDB
 * @alias module:blockchain.ChainDB
 */

class ChainDB {
  /**
   * Create a chaindb.
   * @constructor
   * @param {ChainOptions} options
   */

  constructor(options) {
    this.options = options;
    this.network = this.options.network;
    this.logger = this.options.logger.context('chaindb');
    this.blocks = options.blocks;

    this.db = bdb.create(this.options);
    this.name = 'chain';
    this.version = 3;
    this.tree = new Tree({
      hash: blake2b,
      bits: 256,
      prefix: this.options.treePrefix,
      cacheOnly: true,
      initCacheSize: -1
    });
    this.txn = this.tree.txn();
    this.treeState = new TreeState();
    this.stateCache = new StateCache(this.network);
    this.state = new ChainState();
    this.field = new BitField();
    this.pending = null;
    this.pendingTreeState = null;
    this.current = null;
    this.blocksBatch = null;

    /** @type {LRU<Buffer, ChainEntry>} */
    this.cacheHash = new LRU(this.options.entryCache, null, BufferMap);
    /** @type {LRU<Number, ChainEntry>} */
    this.cacheHeight = new LRU(this.options.entryCache);
  }

  /**
   * Open and wait for the database to load.
   * @returns {Promise<void>}
   */

  async open() {
    this.logger.info('Opening ChainDB...');
    await this.db.open();
    await this.tree.open();

    const migrator = new ChainMigrator({
      ...this.options,
      chainDB: this,
      dbVersion: this.version
    });

    await migrator.migrate();

    const version = await this.db.get(layout.V.encode());

    if (!version) {
      // Database is fresh.
      // Write initial state.
      await this.initialize();
      this.logger.info('ChainDB successfully initialized.');
    } else {
      await this.verifyVersion(this.version);

      const state = await this.getState();
      assert(state);

      // Verify options have not changed.
      await this.verifyFlags();

      // Verify deployment params have not changed.
      await this.verifyDeployments();

      // Load state caches.
      this.stateCache = await this.getStateCache();

      // Grab the chainstate if we have one.
      this.state = state;

      // Grab the current tree state.
      if (!this.options.spv) {
        const treeState = await this.getTreeState();
        assert(treeState);
        this.treeState = treeState;

        if (treeState.compactionHeight !== 0) {
          this.logger.warning(
            `Tree is compacted at ${treeState.compactionHeight}`);
        }

        await this.tree.inject(treeState.treeRoot);
      }

      // Read bitfield.
      this.field = await this.getField();

      this.logger.info('ChainDB successfully loaded.');
    }

    this.txn = this.tree.txn();

    this.logger.info(
      'Chain State: hash=%x tx=%d coin=%d value=%s burned=%s.',
      this.state.tip,
      this.state.tx,
      this.state.coin,
      Amount.coin(this.state.value),
      Amount.coin(this.state.burned));

    this.logger.info('Tree Root: %x.', this.tree.rootHash());
  }

  /**
   * Initialize fresh database.
   * @return {Promise}
   */

  async initialize() {
    this.start();
    try {
      await this._initialize();
    } catch (e) {
      this.drop();
      throw e;
    }

    await this.commit();
  }

  /**
   * Initialize fresh database.
   * @returns {Promise<void>}
   */

  async _initialize() {
    const b = this.batch();
    this.writeVersion(b, this.version);
    this.writeFlags(b);
    this.writeDeployments(b);
    await this.writeGenesis();
  }

  /**
   * Write chaindb version.
   * @param {Batch} b
   * @param {Number} version
   */

  writeVersion(b, version) {
    const value = Buffer.alloc(this.name.length + 4);

    value.write(this.name, 0, 'ascii');
    value.writeUInt32LE(version, this.name.length);

    b.put(layout.V.encode(), value);
  }

  /**
   * Verify version
   * @param {Number} version
   * @returns {Promise<void>}
   */

  async verifyVersion(version) {
    const error = 'Database version mismatch for database: "chain".'
      + ' Please run a data migration before opening.';
    const data = await this.db.get(layout.V.encode());

    if (data.length !== this.name.length + 4)
      throw new Error(error);

    if (data.toString('ascii', 0, this.name.length) !== this.name)
      throw new Error(error);

    const num = data.readUInt32LE(this.name.length);

    if (num !== version)
      throw new Error(error);
  }

  /**
   * Close and wait for the database to close.
   * @returns {Promise<void>}
   */

  async close() {
    await this.tree.close();
    this.txn = this.tree.txn();
    return this.db.close();
  }

  /**
   * Start a batch.
   * @returns {Batch}
   */

  start() {
    assert(!this.current);
    assert(!this.pending);

    this.current = this.db.batch();
    this.pending = this.state.clone();
    this.pendingTreeState = this.treeState.clone();

    if (this.blocks)
      this.blocksBatch = this.blocks.batch();

    this.cacheHash.start();
    this.cacheHeight.start();

    return this.current;
  }

  /**
   * Put key and value to current batch.
   * @param {Buffer} key
   * @param {Buffer} value
   */

  put(key, value) {
    assert(this.current);
    this.current.put(key, value);
  }

  /**
   * Delete key from current batch.
   * @param {Buffer} key
   */

  del(key) {
    assert(this.current);
    this.current.del(key);
  }

  /**
   * Get current batch.
   * @returns {Batch}
   */

  batch() {
    assert(this.current);
    return this.current;
  }

  /**
   * Drop current batch.
   */

  drop() {
    const batch = this.current;
    const blocksBatch = this.blocksBatch;

    assert(this.current);
    assert(this.pending);
    assert(this.pendingTreeState);
    assert(!this.blocks || this.blocksBatch);

    this.current = null;
    this.pending = null;
    this.pendingTreeState = null;
    this.blocksBatch = null;

    this.cacheHash.drop();
    this.cacheHeight.drop();
    this.stateCache.drop();

    batch.clear();

    if (blocksBatch)
      blocksBatch.clear();
  }

  /**
   * Commit current batch.
   * @returns {Promise<void>}
   */

  async commit() {
    assert(this.current);
    assert(this.pending);
    assert(this.pendingTreeState);

    try {
      if (this.blocks)
        await this.blocksBatch.commitWrites();

      await this.current.write();
    } catch (e) {
      this.current = null;
      this.pending = null;
      this.pendingTreeState = null;
      this.cacheHash.drop();
      this.cacheHeight.drop();
      this.blocksBatch = null;
      throw e;
    }

    // Overwrite the entire state
    // with our new best state
    // only if it is committed.
    // Note that alternate chain
    // tips do not commit anything.
    if (this.pending.committed)
      this.state = this.pending;

    // Overwrite the entire TreeState
    // if it's committed. Only happens
    // on tree.commits. @see _saveNames
    if (this.pendingTreeState.committed)
      this.treeState = this.pendingTreeState;

    this.current = null;
    this.pending = null;
    this.pendingTreeState = null;

    this.cacheHash.commit();
    this.cacheHeight.commit();
    this.stateCache.commit();

    if (this.blocks)
      await this.blocksBatch.commitPrunes();
  }

  /**
   * Test the cache for a present entry hash or height.
   * @param {Hash|Number} block - Hash or height.
   */

  hasCache(block) {
    if (typeof block === 'number')
      return this.cacheHeight.has(block);

    assert(Buffer.isBuffer(block));

    return this.cacheHash.has(block);
  }

  /**
   * Get an entry directly from the LRU cache.
   * @param {Hash|Number} block - Hash or height.
   */

  getCache(block) {
    if (typeof block === 'number')
      return this.cacheHeight.get(block);

    assert(Buffer.isBuffer(block));

    return this.cacheHash.get(block);
  }

  /**
   * Get the height of a block by hash.
   * @param {Hash} hash
   * @returns {Promise<Number>}
   */

  async getHeight(hash) {
    if (typeof hash === 'number')
      return hash;

    assert(Buffer.isBuffer(hash));

    if (hash.equals(consensus.ZERO_HASH))
      return -1;

    const entry = this.cacheHash.get(hash);

    if (entry)
      return entry.height;

    const height = await this.db.get(layout.h.encode(hash));

    if (!height)
      return -1;

    return height.readUInt32LE(0);
  }

  /**
   * Get the hash of a block by height. Note that this
   * will only return hashes in the main chain.
   * @param {Hash|Number} height
   * @returns {Promise<Hash>}
   */

  async getHash(height) {
    if (Buffer.isBuffer(height))
      return height;

    assert(typeof height === 'number');

    if (height < 0)
      return null;

    const entry = this.cacheHeight.get(height);

    if (entry)
      return entry.hash;

    return this.db.get(layout.H.encode(height));
  }

  /**
   * Retrieve a chain entry by height.
   * @param {Number} height
   * @returns {Promise<ChainEntry?>}
   */

  async getEntryByHeight(height) {
    assert(typeof height === 'number');

    if (height < 0)
      return null;

    const cache = this.cacheHeight.get(height);

    if (cache)
      return cache;

    const hash = await this.db.get(layout.H.encode(height));

    if (!hash)
      return null;

    const state = this.state;
    const entry = await this.getEntryByHash(hash);

    if (!entry)
      return null;

    // By the time getEntry has completed,
    // a reorg may have occurred. This entry
    // may not be on the main chain anymore.
    if (this.state === state)
      this.cacheHeight.set(entry.height, entry);

    return entry;
  }

  /**
   * Retrieve a chain entry by hash.
   * @param {Hash} hash
   * @returns {Promise<ChainEntry?>}
   */

  async getEntryByHash(hash) {
    assert(Buffer.isBuffer(hash));

    if (hash.equals(consensus.ZERO_HASH))
      return null;

    const cache = this.cacheHash.get(hash);

    if (cache)
      return cache;

    const raw = await this.db.get(layout.e.encode(hash));

    if (!raw)
      return null;

    /** @type {ChainEntry} */
    const entry = ChainEntry.decode(raw);

    // There's no efficient way to check whether
    // this is in the main chain or not, so
    // don't add it to the height cache.
    this.cacheHash.set(entry.hash, entry);

    return entry;
  }

  /**
   * Retrieve a chain entry.
   * @param {Number|Hash} block - Height or hash.
   * @returns {Promise<ChainEntry?>}
   */

  getEntry(block) {
    if (typeof block === 'number')
      return this.getEntryByHeight(block);
    return this.getEntryByHash(block);
  }

  /**
   * Test whether the chain contains a block.
   * @param {Hash} hash
   * @returns {Promise<Boolean>}
   */

  async hasEntry(hash) {
    const height = await this.getHeight(hash);
    return height !== -1;
  }

  /**
   * Get ancestor by `height`.
   * @param {ChainEntry} entry
   * @param {Number} height
   * @returns {Promise<ChainEntry?>}
   */

  async getAncestor(entry, height) {
    if (height < 0)
      return null;

    assert(height >= 0);
    assert(height <= entry.height);

    if (await this.isMainChain(entry))
      return this.getEntryByHeight(height);

    while (entry.height !== height) {
      const cache = this.getPrevCache(entry);

      if (cache)
        entry = cache;
      else
        entry = await this.getPrevious(entry);

      assert(entry);
    }

    return entry;
  }

  /**
   * Get previous entry.
   * @param {ChainEntry} entry
   * @returns {Promise<ChainEntry?>}
   */

  getPrevious(entry) {
    return this.getEntryByHash(entry.prevBlock);
  }

  /**
   * Get previous cached entry.
   * @param {ChainEntry} entry
   * @returns {ChainEntry?}
   */

  getPrevCache(entry) {
    return this.cacheHash.get(entry.prevBlock) || null;
  }

  /**
   * Get next entry.
   * @param {ChainEntry} entry
   * @returns {Promise<ChainEntry?>}
   */

  async getNext(entry) {
    const hash = await this.getNextHash(entry.hash);

    if (!hash)
      return null;

    return this.getEntryByHash(hash);
  }

  /**
   * Get next entry.
   * @param {ChainEntry} entry
   * @returns {Promise<ChainEntry?>}
   */

  async getNextEntry(entry) {
    const next = await this.getEntryByHeight(entry.height + 1);

    if (!next)
      return null;

    // Not on main chain.
    if (!next.prevBlock.equals(entry.hash))
      return null;

    return next;
  }

  /**
   * Lookup a name tree value.
   * @param {Hash} root
   * @param {Hash} key
   * @returns {Promise<Buffer>}
   */

  async lookup(root, key) {
    if (this.options.spv)
      throw new Error('Cannot lookup in SPV mode.');

    const tree = this.tree.snapshot(root);
    return tree.get(key);
  }

  /**
   * Create a name tree proof.
   * @param {Hash} root
   * @param {Hash} key
   * @returns {Promise<Proof>} nodes
   */

  async prove(root, key) {
    if (this.options.spv)
      throw new Error('Cannot prove in SPV mode.');

    const tree = this.tree.snapshot(root);
    return tree.prove(key);
  }

  /**
   * Get the current name tree root.
   * @returns {Hash}
   */

  treeRoot() {
    return this.tree.rootHash();
  }

  /**
   * Retrieve the tip entry from the tip record.
   * @returns {Promise<ChainEntry?>}
   */

  getTip() {
    return this.getEntryByHash(this.state.tip);
  }

  /**
   * Retrieve the tip entry from the tip record.
   * @returns {Promise<ChainState?>}
   */

  async getState() {
    const data = await this.db.get(layout.R.encode());

    if (!data)
      return null;

    return ChainState.decode(data);
  }

  /**
   * Retrieve tree state from the tree record.
   * @returns {Promise<TreeState?>}
   */

  async getTreeState() {
    const data = await this.db.get(layout.s.encode());

    if (!data)
      return null;

    return TreeState.decode(data);
  }

  /**
   * Write genesis block to database.
   * @returns {Promise<void>}
   */

  async writeGenesis() {
    const network = this.network;
    const block = Block.decode(network.genesisBlock);
    const entry = ChainEntry.fromBlock(block);
    const view = new CoinView();

    this.logger.info('Writing genesis block to ChainDB.');

    for (let i = 0; i < block.txs.length; i++) {
      const tx = block.txs[i];

      if (i > 0)
        assert(await view.spendInputs(this, tx));

      view.addTX(tx, 0);
    }

    for (let i = 0; i < block.txs.length; i++) {
      const tx = block.txs[i];
      assert(tx.isSane());
      assert(tx.verifyInputs(view, network.coinbaseMaturity, network));
    }

    return this._save(entry, block, view);
  }

  /**
   * Retrieve the database flags.
   * @returns {Promise<ChainFlags?>}
   */

  async getFlags() {
    const data = await this.db.get(layout.O.encode());

    if (!data)
      return null;

    return ChainFlags.decode(data);
  }

  /**
   * Verify current options against db options.
   * @returns {Promise<void>}
   */

  async verifyFlags() {
    const options = this.options;
    const flags = await this.getFlags();

    if (!flags)
      throw new Error('No flags found.');

    if (options.network !== flags.network)
      throw new Error('Network mismatch for chain.');

    if (options.spv && !flags.spv)
      throw new Error('Cannot retroactively enable SPV.');

    if (!options.spv && flags.spv)
      throw new Error('Cannot retroactively disable SPV.');

    if (options.prune && !flags.prune)
      throw new Error('Cannot retroactively prune.');

    if (!options.prune && flags.prune)
      throw new Error('Cannot retroactively unprune.');

    if (options.indexTX && !flags.indexTX)
      throw new Error('Cannot retroactively enable TX indexing.');

    if (!options.indexTX && flags.indexTX)
      throw new Error('Cannot retroactively disable TX indexing.');

    if (options.indexAddress && !flags.indexAddress)
      throw new Error('Cannot retroactively enable address indexing.');

    if (!options.indexAddress && flags.indexAddress)
      throw new Error('Cannot retroactively disable address indexing.');
  }

  /**
   * Get state caches.
   * @returns {Promise<StateCache>}
   */

  async getStateCache() {
    const stateCache = new StateCache(this.network);

    const items = await this.db.range({
      gte: layout.v.min(),
      lte: layout.v.max()
    });

    for (const item of items) {
      const [bit, hash] = layout.v.decode(item.key);
      const state = item.value[0];
      stateCache.insert(bit, hash, state);
    }

    return stateCache;
  }

  /**
   * Save deployment table.
   * @returns {Promise<void>}
   */

  saveDeployments() {
    const b = this.db.batch();
    this.writeDeployments(b);
    return b.write();
  }

  /**
   * Save deployment table.
   * @param {Batch} b
   */

  writeDeployments(b) {
    const bw = bio.write(1 + 17 * this.network.deploys.length);

    bw.writeU8(this.network.deploys.length);

    for (const deployment of this.network.deploys) {
      bw.writeU8(deployment.bit);
      bw.writeU32(deployment.startTime);
      bw.writeU32(deployment.timeout);
      bw.writeI32(deployment.threshold);
      bw.writeI32(deployment.window);
    }

    b.put(layout.D.encode(), bw.render());
  }

  /**
   * Check for outdated deployments.
   * @private
   * @returns {Promise<Number[]>}
   */

  async checkDeployments() {
    const raw = await this.db.get(layout.D.encode());

    assert(raw, 'No deployment table found.');

    const br = bio.read(raw);
    const count = br.readU8();
    const invalid = [];

    for (let i = 0; i < count; i++) {
      const bit = br.readU8();
      const start = br.readU32();
      const timeout = br.readU32();
      const threshold = br.readI32();
      const window = br.readI32();
      const deployment = this.network.byBit(bit);

      if (deployment
          && start === deployment.startTime
          && timeout === deployment.timeout
          && threshold === deployment.threshold
          && window === deployment.window) {
        continue;
      }

      invalid.push(bit);
    }

    return invalid;
  }

  /**
   * Potentially invalidate state cache.
   * @returns {Promise<Boolean>}
   */

  async verifyDeployments() {
    let invalid;

    try {
      invalid = await this.checkDeployments();
    } catch (e) {
      if (e.type !== 'EncodingError')
        throw e;
      invalid = [];
      for (let i = 0; i < 32; i++)
        invalid.push(i);
    }

    if (invalid.length === 0)
      return true;

    const b = this.db.batch();

    for (const bit of invalid) {
      this.logger.warning('Versionbit deployment params modified.');
      this.logger.warning('Invalidating cache for bit %d.', bit);
      await this.invalidateCache(bit, b);
    }

    this.writeDeployments(b);

    await b.write();

    return false;
  }

  /**
   * Invalidate state cache.
   * @private
   * @param {Number} bit
   * @param {Batch} b
   * @returns {Promise<void>}
   */

  async invalidateCache(bit, b) {
    const keys = await this.db.keys({
      gte: layout.v.min(bit),
      lte: layout.v.max(bit)
    });

    for (const key of keys)
      b.del(key);
  }

  /**
   * Retroactively prune the database.
   * @returns {Promise<Boolean>}
   */

  async prune() {
    assert(!this.options.spv, 'Cannot prune chain in SPV mode.');

    const options = this.options;
    const keepBlocks = this.network.block.keepBlocks;
    const pruneAfter = this.network.block.pruneAfterHeight;

    const flags = await this.getFlags();

    if (flags.prune)
      throw new Error('Chain is already pruned.');

    const height = await this.getHeight(this.state.tip);

    if (height <= pruneAfter + keepBlocks)
      return false;

    const start = pruneAfter + 1;
    const end = height - keepBlocks;

    const blocksBatch = this.blocks.batch();

    for (let i = start; i <= end; i++) {
      const hash = await this.getHash(i);

      if (!hash)
        throw new Error(`Cannot find hash for ${i}.`);

      blocksBatch.pruneBlock(hash);
      blocksBatch.pruneUndo(hash);
    }

    // We do blockstore write first, because if something
    // fails during this batch, then db flag wont be set.
    // If user just reruns the node prune will restart.
    await blocksBatch.commit();

    try {
      options.prune = true;

      const flags = ChainFlags.fromOptions(options);
      assert(flags.prune);

      await this.db.put(layout.O.encode(), flags.encode());
    } catch (e) {
      options.prune = false;
      throw e;
    }

    return true;
  }

  /**
   * Compact the Urkel Tree.
   * Removes all historical state and all data not
   * linked directly to the provided root node hash.
   * @param {ChainEntry} entry
   * @returns {Promise<void>}
   */

  async compactTree(entry) {
    // Before doing anything to the tree,
    // save the target tree root hash to chain database.
    // If the tree data gets out of sync or corrupted
    // the chain database knows where to resync the tree from.
    this.start();

    // Note: the tree root commit height is always one block before its
    // appearence in a header.
    this.put(layout.s.encode(), this.pendingTreeState.commit(
      entry.treeRoot,
      entry.height - 1
    ));
    await this.commit();

    const tmpDir = this.options.treePrefix + '~';

    const tmpTree = new Tree({
      hash: blake2b,
      bits: 256,
      prefix: tmpDir,
      cacheOnly: false,
      initCacheSize: 0
    });

    // Make sure to remove the tmp directory first.
    // There should not be directory, unless it was
    // stopped in the middle of compaction.
    // Otherwise compacted tree would add on top
    // of the previsouly compacted db.
    await tmpTree.open();
    const tmpStore = tmpTree.store;
    await tmpTree.close();
    await tmpStore.destroy();

    // Rewind tree to historical commitment
    await this.tree.inject(entry.treeRoot);

    // Delete historical data
    await this.tree.compact(tmpDir);

    // Reset in-memory tree delta
    this.txn = this.tree.txn();

    // Mark tree compaction complete
    this.start();
    this.pendingTreeState.compact(entry.treeRoot, entry.height);
    this.put(layout.s.encode(), this.pendingTreeState.commit(
      entry.treeRoot,
      entry.height - 1
    ));
    await this.commit();
  }

  /**
   * Get the _next_ block hash (does not work by height).
   * @param {Hash} hash
   * @returns {Promise<Hash>}
   */

  async getNextHash(hash) {
    return this.db.get(layout.n.encode(hash));
  }

  /**
   * Check to see if a block is on the main chain.
   * @param {Hash} hash
   * @returns {Promise<Boolean>}
   */

  async isMainHash(hash) {
    assert(Buffer.isBuffer(hash));

    if (hash.equals(consensus.ZERO_HASH))
      return false;

    if (hash.equals(this.network.genesis.hash))
      return true;

    if (hash.equals(this.state.tip))
      return true;

    const cacheHash = this.cacheHash.get(hash);

    if (cacheHash) {
      const cacheHeight = this.cacheHeight.get(cacheHash.height);
      if (cacheHeight)
        return cacheHeight.hash.equals(hash);
    }

    if (await this.getNextHash(hash))
      return true;

    return false;
  }

  /**
   * Test whether the entry is in the main chain.
   * @param {ChainEntry} entry
   * @returns {Promise<Boolean>}
   */

  async isMainChain(entry) {
    if (entry.isGenesis())
      return true;

    if (entry.hash.equals(this.state.tip))
      return true;

    const cache = this.getCache(entry.height);

    if (cache)
      return entry.hash.equals(cache.hash);

    if (await this.getNextHash(entry.hash))
      return true;

    return false;
  }

  /**
   * Get hash range.
   * @param {Number} [start=-1]
   * @param {Number} [end=-1]
   * @returns {Promise<Hash[]>}
   */

  async getHashes(start = -1, end = -1) {
    if (start === -1)
      start = 0;

    if (end === -1)
      end >>>= 0;

    assert((start >>> 0) === start);
    assert((end >>> 0) === end);

    return this.db.values({
      gte: layout.H.min(start),
      lte: layout.H.max(end)
    });
  }

  /**
   * Get entries range.
   * @param {Number} [start=-1]
   * @param {Number} [end=-1]
   * @returns {Promise<ChainEntry[]>}
   */

  async getEntries(start = -1, end = -1) {
    if (start === -1)
      start = 0;

    if (end === -1)
      end >>>= 0;

    assert((start >>> 0) === start);
    assert((end >>> 0) === end);

    const hashes = await this.getHashes(start, end);

    return Promise.all(hashes.map((hash) => {
      return this.getEntryByHash(hash);
    }));
  }

  /**
   * Get all tip hashes.
   * @returns {Promise<Hash[]>}
   */

  async getTips() {
    return this.db.keys({
      gte: layout.p.min(),
      lte: layout.p.max(),
      parse: key => layout.p.decode(key)[0]
    });
  }

  /**
   * Get bitfield.
   * @returns {Promise<BitField>}
   */

  async getField() {
    const raw = await this.db.get(layout.f.encode());

    if (!raw)
      return new BitField();

    return BitField.decode(raw);
  }

  /**
   * Get a coin (unspents only).
   * @param {Outpoint} prevout
   * @returns {Promise<CoinEntry?>}
   */

  async readCoin(prevout) {
    if (this.options.spv)
      return null;

    const {hash, index} = prevout;

    const raw = await this.db.get(layout.c.encode(hash, index));

    if (!raw)
      return null;

    return CoinEntry.decode(raw);
  }

  /**
   * Get a coin (unspents only).
   * @param {Hash} hash
   * @param {Number} index
   * @returns {Promise<Coin?>}
   */

  async getCoin(hash, index) {
    const prevout = new Outpoint(hash, index);
    const coin = await this.readCoin(prevout);

    if (!coin)
      return null;

    return coin.toCoin(prevout);
  }

  /**
   * Check whether coins are still unspent. Necessary for bip30.
   * @see https://bitcointalk.org/index.php?topic=67738.0
   * @param {TX} tx
   * @returns {Promise<Boolean>}
   */

  async hasCoins(tx) {
    for (let i = 0; i < tx.outputs.length; i++) {
      const key = layout.c.encode(tx.hash(), i);
      if (await this.db.has(key))
        return true;
    }
    return false;
  }

  /**
   * Get coin viewpoint.
   * @param {TX} tx
   * @returns {Promise<CoinView>}
   */

  async getCoinView(tx) {
    const view = new CoinView();

    for (const {prevout} of tx.inputs) {
      const coin = await this.readCoin(prevout);

      if (coin)
        view.addEntry(prevout, coin);
    }

    return view;
  }

  /**
   * Get coin viewpoint (historical).
   * @param {TX} tx
   * @returns {Promise<CoinView>}
   */

  async getSpentView(tx) {
    const view = await this.getCoinView(tx);

    for (const {prevout} of tx.inputs) {
      if (view.hasEntry(prevout))
        continue;

      const {hash, index} = prevout;
      const meta = await this.getMeta(hash);

      if (!meta)
        continue;

      const {tx, height} = meta;

      if (index < tx.outputs.length)
        view.addIndex(tx, index, height);
    }

    return view;
  }

  /**
   * Get coins necessary to be resurrected during a reorg.
   * @param {Hash} hash
   * @returns {Promise<UndoCoins>}
   */

  async getUndoCoins(hash) {
    const data = await this.blocks.readUndo(hash);

    if (!data)
      return new UndoCoins();

    return UndoCoins.decode(data);
  }

  /**
   * Get name state.
   * @param {Buffer} nameHash
   * @returns {Promise<NameState>}
   */

  async getNameState(nameHash) {
    const raw = await this.txn.get(nameHash);

    if (!raw)
      return null;

    const ns = NameState.decode(raw);
    ns.nameHash = nameHash;
    return ns;
  }

  /**
   * Get name state by name.
   * @param {Buffer} name
   * @returns {Promise<NameState>}
   */

  async getNameStateByName(name) {
    return this.getNameState(rules.hashName(name));
  }

  /**
   * Get name status.
   * @param {Buffer} nameHash
   * @param {Number} height - used for expiration checks.
   * @returns {Promise<NameState>}
   */

  async getNameStatus(nameHash, height) {
    assert(Buffer.isBuffer(nameHash));
    assert((height >>> 0) === height);

    const network = this.network;
    const ns = await this.getNameState(nameHash);

    if (!ns) {
      const state = new NameState();
      state.reset(height);
      return state;
    }

    ns.maybeExpire(height, network);

    return ns;
  }

  /**
   * Retrieve a block from the database (not filled with coins).
   * @param {Hash} hash
   * @returns {Promise<Block?>}
   */

  async getBlock(hash) {
    const data = await this.getRawBlock(hash);

    if (!data)
      return null;

    return Block.decode(data);
  }

  /**
   * Retrieve a block from the database (not filled with coins).
   * @param {Hash|Number} hashHeight
   * @returns {Promise<Buffer?>}
   */

  async getRawBlock(hashHeight) {
    if (this.options.spv)
      return null;

    const hash = await this.getHash(hashHeight);

    if (!hash)
      return null;

    return this.blocks.readBlock(hash);
  }

  /**
   * Get a historical block coin viewpoint.
   * @param {Block} block
   * @returns {Promise<CoinView>}
   */

  async getBlockView(block) {
    const view = new CoinView();
    const undo = await this.getUndoCoins(block.hash());

    if (undo.isEmpty())
      return view;

    for (let i = block.txs.length - 1; i > 0; i--) {
      const tx = block.txs[i];

      for (let j = tx.inputs.length - 1; j >= 0; j--) {
        const input = tx.inputs[j];
        undo.apply(view, input.prevout);
      }
    }

    // Undo coins should be empty.
    assert(undo.isEmpty(), 'Undo coins data inconsistency.');

    return view;
  }

  /**
   * Get a transaction with metadata.
   * @param {Hash} hash
   * @returns {Promise<TXMeta?>}
   */

  async getMeta(hash) {
    if (!this.options.indexTX)
      return null;

    const data = await this.db.get(layout.t.encode(hash));

    if (!data)
      return null;

    return TXMeta.decode(data);
  }

  /**
   * Retrieve a transaction.
   * @param {Hash} hash
   * @returns {Promise<TX?>}
   */

  async getTX(hash) {
    const meta = await this.getMeta(hash);

    if (!meta)
      return null;

    return meta.tx;
  }

  /**
   * @param {Hash} hash
   * @returns {Promise<Boolean>}
   */

  async hasTX(hash) {
    if (!this.options.indexTX)
      return false;

    return this.db.has(layout.t.encode(hash));
  }

  /**
   * Get all coins pertinent to an address.
   * @param {Address[]} addrs
   * @returns {Promise<Coin[]>}
   */

  async getCoinsByAddress(addrs) {
    if (!this.options.indexAddress)
      return [];

    if (!Array.isArray(addrs))
      addrs = [addrs];

    const coins = [];

    for (let addr of addrs) {
      if (typeof addr === 'string')
        addr = Address.fromString(addr);

      const hash = Address.getHash(addr);

      const keys = await this.db.keys({
        gte: layout.C.min(hash),
        lte: layout.C.max(hash),
        parse: (key) => {
          const [, txid, index] = layout.C.decode(key);
          return [txid, index];
        }
      });

      for (const [hash, index] of keys) {
        const coin = await this.getCoin(hash, index);
        assert(coin);
        coins.push(coin);
      }
    }

    return coins;
  }

  /**
   * Get all transaction hashes to an address.
   * @param {Address[]} addrs
   * @returns {Promise<Hash[]>}
   */

  async getHashesByAddress(addrs) {
    if (!this.options.indexTX || !this.options.indexAddress)
      return [];

    const hashes = new BufferSet();

    for (const addr of addrs) {
      const hash = Address.getHash(addr);

      await this.db.keys({
        gte: layout.T.min(hash),
        lte: layout.T.max(hash),
        parse: (key) => {
          const [, txid] = layout.T.decode(key);
          hashes.add(txid);
        }
      });
    }

    return hashes.toArray();
  }

  /**
   * Get all transactions pertinent to an address.
   * @param {Address[]} addrs
   * @returns {Promise<TX[]>}
   */

  async getTXByAddress(addrs) {
    const mtxs = await this.getMetaByAddress(addrs);
    const out = [];

    for (const mtx of mtxs)
      out.push(mtx.tx);

    return out;
  }

  /**
   * Get all transactions pertinent to an address.
   * @param {Address[]} addrs
   * @returns {Promise<TXMeta[]>}
   */

  async getMetaByAddress(addrs) {
    if (!this.options.indexTX || !this.options.indexAddress)
      return [];

    if (!Array.isArray(addrs))
      addrs = [addrs];

    const hashes = await this.getHashesByAddress(addrs);
    const mtxs = [];

    for (const hash of hashes) {
      const mtx = await this.getMeta(hash);
      assert(mtx);
      mtxs.push(mtx);
    }

    return mtxs;
  }

  /**
   * Scan the blockchain for transactions containing specified address hashes.
   * @param {Hash|Number} start - Block hash or height to start at.
   * @param {BloomFilter} filter - Bloomfilter containing tx and address hashes.
   * @param {Function} iter - Iterator.
   * @returns {Promise<void>}
   */

  async scan(start, filter, iter) {
    if (start == null)
      start = this.network.genesis.hash;

    if (typeof start === 'number')
      this.logger.info('Scanning from height %d.', start);
    else
      this.logger.info('Scanning from block %x.', start);

    let entry = await this.getEntry(start);

    if (!entry)
      return;

    if (!await this.isMainChain(entry))
      throw new Error('Cannot rescan an alternate chain.');

    let total = 0;

    while (entry) {
      const block = await this.getBlock(entry.hash);

      total += 1;

      const txs = [];

      if (!block) {
        if (!this.options.spv && !this.options.prune)
          throw new Error('Block not found.');
        await iter(entry, txs);
        entry = await this.getNext(entry);
        continue;
      }

      this.logger.info(
        'Scanning block %x (%d).',
        entry.hash, entry.height);

      for (const tx of block.txs) {
        if (tx.testAndMaybeUpdate(filter))
          txs.push(tx);
      }

      await iter(entry, txs);

      entry = await this.getNext(entry);
    }

    this.logger.info('Finished scanning %d blocks.', total);
  }

  /**
   * @typedef {Object} ScanBlockResult
   * @property {ChainEntry} entry
   * @property {TX[]} txs
   */

  /**
   * Interactive scans block checks.
   * @param {Hash|Number} blockID - Block hash or height to start at.
   * @param {BloomFilter} [filter] - Starting bloom filter containing tx,
   * address and name hashes.
   * @returns {Promise<ScanBlockResult>}
   */

  async scanBlock(blockID, filter) {
    assert(blockID != null);

    const entry = await this.getEntry(blockID);

    if (!entry)
      throw new Error('Could not find entry.');

    if (!await this.isMainChain(entry))
      throw new Error('Cannot rescan an alternate chain.');

    const block = await this.getBlock(entry.hash);

    if (!block)
      throw new Error('Block not found.');

    this.logger.info(
      'Scanning block %x (%d)',
      entry.hash, entry.height);

    let txs = [];

    if (!filter) {
      txs = block.txs;
    } else {
      for (const tx of block.txs) {
        if (tx.testAndMaybeUpdate(filter))
          txs.push(tx);
      }
    }

    return {
      entry,
      txs
    };
  }

  /**
   * Save an entry to the database and optionally
   * connect it as the tip. Note that this method
   * does _not_ perform any verification which is
   * instead performed in {@link Chain#add}.
   * @param {ChainEntry} entry
   * @param {Block} block
   * @param {CoinView?} [view] - Will not connect if null.
   * @returns {Promise<void>}
   */

  async save(entry, block, view) {
    this.start();
    try {
      await this._save(entry, block, view);
    } catch (e) {
      this.drop();
      throw e;
    }
    await this.commit();
  }

  /**
   * Save an entry.
   * @private
   * @param {ChainEntry} entry
   * @param {Block} block
   * @param {CoinView?} [view]
   * @returns {Promise<void>}
   */

  async _save(entry, block, view) {
    const hash = block.hash();

    // Hash->height index.
    this.put(layout.h.encode(hash), fromU32(entry.height));

    // Entry data.
    this.put(layout.e.encode(hash), entry.encode());
    this.cacheHash.push(entry.hash, entry);

    // Tip index.
    this.del(layout.p.encode(entry.prevBlock));
    this.put(layout.p.encode(hash), null);

    // Update state caches.
    this.saveUpdates();

    if (!view) {
      // Save block data.
      await this.saveBlock(entry, block);
      return;
    }

    // Hash->next-block index.
    if (!entry.isGenesis())
      this.put(layout.n.encode(entry.prevBlock), hash);

    // Height->hash index.
    this.put(layout.H.encode(entry.height), hash);
    this.cacheHeight.push(entry.height, entry);

    // Connect block and save data.
    await this.saveBlock(entry, block, view);

    // Commit new chain state.
    this.put(layout.R.encode(), this.pending.commit(hash));
  }

  /**
   * Reconnect the block to the chain.
   * @param {ChainEntry} entry
   * @param {Block} block
   * @param {CoinView} view
   * @returns {Promise<void>}
   */

  async reconnect(entry, block, view) {
    this.start();
    try {
      await this._reconnect(entry, block, view);
    } catch (e) {
      this.drop();
      throw e;
    }
    await this.commit();
  }

  /**
   * Reconnect block.
   * @private
   * @param {ChainEntry} entry
   * @param {Block} block
   * @param {CoinView} view
   * @returns {Promise<void>}
   */

  async _reconnect(entry, block, view) {
    const hash = block.hash();

    assert(!entry.isGenesis());

    // We can now add a hash->next-block index.
    this.put(layout.n.encode(entry.prevBlock), hash);

    // We can now add a height->hash index.
    this.put(layout.H.encode(entry.height), hash);
    this.cacheHeight.push(entry.height, entry);

    // Re-insert into cache.
    this.cacheHash.push(entry.hash, entry);

    // Update state caches.
    this.saveUpdates();

    // Connect inputs.
    await this.connectBlock(entry, block, view);

    // Update chain state.
    this.put(layout.R.encode(), this.pending.commit(hash));
  }

  /**
   * Disconnect block from the chain.
   * @param {ChainEntry} entry
   * @param {Block} block
   * @returns {Promise<CoinView>}
   */

  async disconnect(entry, block) {
    this.start();

    let view;
    try {
      view = await this._disconnect(entry, block);
    } catch (e) {
      this.drop();
      throw e;
    }

    await this.commit();

    return view;
  }

  /**
   * Disconnect block.
   * @private
   * @param {ChainEntry} entry
   * @param {Block} block
   * @returns {Promise<CoinView>}
   */

  async _disconnect(entry, block) {
    // Remove hash->next-block index.
    this.del(layout.n.encode(entry.prevBlock));

    // Remove height->hash index.
    this.del(layout.H.encode(entry.height));
    this.cacheHeight.unpush(entry.height);

    // Update state caches.
    this.saveUpdates();

    // Disconnect inputs.
    const view = await this.disconnectBlock(entry, block);

    // Revert chain state to previous tip.
    this.put(layout.R.encode(), this.pending.commit(entry.prevBlock));

    return view;
  }

  /**
   * Save state cache updates.
   * @private
   * @returns {void}
   */

  saveUpdates() {
    const updates = this.stateCache.updates;

    if (updates.length === 0)
      return;

    this.logger.info('Saving %d state cache updates.', updates.length);

    for (const update of updates) {
      const {bit, hash} = update;
      this.put(layout.v.encode(bit, hash), update.encode());
    }
  }

  /**
   * Reset the chain to a height or hash. Useful for replaying
   * the blockchain download for SPV.
   * @param {Hash|Number} block - hash/height
   * @returns {Promise<ChainEntry?>}
   */

  async reset(block) {
    const entry = await this.getEntry(block);

    if (!entry)
      throw new Error('Block not found.');

    if (!await this.isMainChain(entry))
      throw new Error('Cannot reset on alternate chain.');

    if (this.options.prune)
      throw new Error('Cannot reset when pruned.');

    if (this.treeState.compactionHeight !== 0)
      throw new Error('Cannot reset when tree is compacted.');

    // We need to remove all alternate
    // chains first. This is ugly, but
    // it's the only safe way to reset
    // the chain.
    await this.removeChains();

    let tip = await this.getTip();
    assert(tip);

    this.logger.debug('Resetting main chain to: %x', entry.hash);

    for (;;) {
      this.start();

      // Stop once we hit our target tip.
      if (tip.hash.equals(entry.hash)) {
        this.put(layout.R.encode(), this.pending.commit(tip.hash));
        await this.commit();
        break;
      }

      assert(!tip.isGenesis());

      // Revert the tip index.
      this.del(layout.p.encode(tip.hash));
      this.put(layout.p.encode(tip.prevBlock), null);

      // Remove all records (including
      // main-chain-only records).
      this.del(layout.H.encode(tip.height));
      this.del(layout.h.encode(tip.hash));
      this.del(layout.e.encode(tip.hash));
      this.del(layout.n.encode(tip.prevBlock));

      // Disconnect and remove block data.
      try {
        await this.removeBlock(tip);
      } catch (e) {
        this.drop();
        throw e;
      }

      // Revert chain state to previous tip.
      this.put(layout.R.encode(), this.pending.commit(tip.prevBlock));

      await this.commit();

      // Update caches _after_ successful commit.
      this.cacheHeight.remove(tip.height);
      this.cacheHash.remove(tip.hash);

      tip = await this.getPrevious(tip);
      assert(tip);
    }

    return tip;
  }

  /**
   * Remove all alternate chains.
   * @returns {Promise<void>}
   */

  async removeChains() {
    const tips = await this.getTips();

    // Note that this has to be
    // one giant atomic write!
    this.start();

    try {
      for (const tip of tips)
        await this._removeChain(tip);
    } catch (e) {
      this.drop();
      throw e;
    }

    await this.commit();
  }

  /**
   * Remove an alternate chain.
   * @private
   * @param {Hash} hash - Alternate chain tip.
   * @returns {Promise<void>}
   */

  async _removeChain(hash) {
    let tip = await this.getEntryByHash(hash);

    if (!tip)
      throw new Error('Alternate chain tip not found.');

    this.logger.debug('Removing alternate chain: %x.', tip.hash);

    for (;;) {
      if (await this.isMainChain(tip))
        break;

      assert(!tip.isGenesis());

      // Remove all non-main-chain records.
      this.del(layout.p.encode(tip.hash));
      this.del(layout.h.encode(tip.hash));
      this.del(layout.e.encode(tip.hash));

      if (this.blocks)
        this.blocksBatch.pruneBlock(tip.hash);

      // Queue up hash to be removed
      // on successful write.
      this.cacheHash.unpush(tip.hash);

      tip = await this.getPrevious(tip);
      assert(tip);
    }
  }

  /**
   * Save a block (not an entry) to the
   * database and potentially connect the inputs.
   * @param {ChainEntry} entry
   * @param {Block} block
   * @param {CoinView?} [view]
   * @returns {Promise<void>}
   */

  async saveBlock(entry, block, view) {
    const hash = block.hash();

    if (this.options.spv)
      return undefined;

    // Write actual block data
    this.blocksBatch.writeBlock(hash, block.encode());

    if (!view)
      return undefined;

    return this.connectBlock(entry, block, view);
  }

  /**
   * Remove a block (not an entry) to the database.
   * Disconnect inputs.
   * @param {ChainEntry} entry
   * @returns {Promise<CoinView>}
   */

  async removeBlock(entry) {
    if (this.options.spv)
      return new CoinView();

    const block = await this.getBlock(entry.hash);

    if (!block)
      throw new Error('Block not found.');

    this.blocksBatch.pruneBlock(block.hash());

    return this.disconnectBlock(entry, block);
  }

  /**
   * Commit coin view to database.
   * @private
   * @param {CoinView} view
   */

  saveView(view) {
    for (const [hash, coins] of view.map) {
      for (const [index, coin] of coins.outputs) {
        if (coin.spent) {
          this.del(layout.c.encode(hash, index));
          continue;
        }

        const raw = coin.encode();

        this.put(layout.c.encode(hash, index), raw);
      }
    }

    // Not optimal. Should be made a file in the future.
    if (view.bits.commit(this.field))
      this.put(layout.f.encode(), this.field.encode());
  }

  /**
   * Commit names to tree.
   * @param {CoinView} view
   * @param {ChainEntry} entry
   * @param {Boolean} revert
   */

  async saveNames(view, entry, revert) {
    this.start();
    try {
      await this._saveNames(view, entry, revert);
    } catch (e) {
      this.drop();
      throw e;
    }
    await this.commit();
  }

  /**
   * Commit names to tree, assuming batch is started.
   * @private
   * @param {CoinView} view
   * @param {ChainEntry} entry
   * @param {Boolean} revert
   * @returns {Promise<void>}
   */

  async _saveNames(view, entry, revert) {
    for (const ns of view.names.values()) {
      const {nameHash} = ns;

      if (ns.isNull()) {
        await this.txn.remove(nameHash);
        continue;
      }

      await this.txn.insert(nameHash, ns.encode());
    }

    if ((entry.height % this.network.names.treeInterval) === 0) {
      // Explanation:
      //
      // During a reorg, we must revert the snapshot
      // back to the beginning of the interval. We
      // can still incrementally revert the database
      // transaction with state deltas, but unless
      // we get the tree hash back to what it was
      // at the start, we will end up rejecting blocks
      // during reconnection.
      //
      // This is an invalid state that cannot be
      // recovered from. Luckily, the block we're
      // disconnecting commits to the _previous_ tree
      // root, not the current one.
      if (revert)
        await this.tree.inject(entry.treeRoot);
      else
        await this.txn.commit();

      // Commit new tree state.
      // Chain will need to recover current txn
      // from treeState.commitHeight + 1 (including).
      this.put(layout.s.encode(), this.pendingTreeState.commit(
        this.tree.rootHash(),
        entry.height
      ));
    }
  }

  /**
   * Connect names to tree.
   * @private
   * @param {CoinView} view
   * @param {ChainEntry} entry
   */

  async connectNames(view, entry) {
    const undo = view.toNameUndo();

    if (undo.names.length === 0)
      this.del(layout.w.encode(entry.height));
    else
      this.put(layout.w.encode(entry.height), undo.encode());

    return this._saveNames(view, entry, false);
  }

  /**
   * Disconnect names from tree.
   * @private
   * @param {CoinView} view
   * @param {ChainEntry} entry
   * @returns {Promise<void>}
   */

  async disconnectNames(view, entry) {
    const raw = await this.db.get(layout.w.encode(entry.height));

    if (raw) {
      const undo = NameUndo.decode(raw);

      for (const [nameHash, delta] of undo.names) {
        const ns = await view.getNameState(this, nameHash);

        ns.applyState(delta);
      }

      this.del(layout.w.encode(entry.height));
    }

    return this._saveNames(view, entry, true);
  }

  /**
   * Connect block inputs.
   * @param {ChainEntry} entry
   * @param {Block} block
   * @param {CoinView} view
   * @returns {Promise<void>}
   */

  async connectBlock(entry, block, view) {
    if (this.options.spv)
      return undefined;

    const hash = block.hash();

    this.pending.connect(block);

    // Update chain state value.
    for (let i = 0; i < block.txs.length; i++) {
      const tx = block.txs[i];

      if (i > 0) {
        for (const {prevout} of tx.inputs) {
          const output = view.getOutput(prevout);
          assert(output);

          // REGISTER->REVOKE covenants have no effect.
          if (output.covenant.type >= types.REGISTER
              && output.covenant.type <= types.REVOKE) {
            continue;
          }

          this.pending.spend(output);
        }
      }

      for (let i = 0; i < tx.outputs.length; i++) {
        const output = tx.outputs[i];

        if (output.isUnspendable())
          continue;

        // Registers are burned.
        if (output.covenant.isRegister())
          this.pending.burn(output);

        // REGISTER->REVOKE covenants have no effect.
        if (output.covenant.type >= types.REGISTER
            && output.covenant.type <= types.REVOKE) {
          continue;
        }

        // Only add value from the first claim.
        if (output.covenant.isClaim()) {
          if (output.covenant.getU32(5) !== 1)
            continue;
        }

        this.pending.add(output);
      }

      // Index the transaction if enabled.
      this.indexTX(tx, view, entry, i);
    }

    // Commit new coin state.
    this.saveView(view);

    // Write undo coins (if there are any).
    if (!view.undo.isEmpty())
      this.blocksBatch.writeUndo(hash, view.undo.commit());

    // Prune height-288 if pruning is enabled.
    await this.pruneBlock(entry);

    // Connect name state.
    return this.connectNames(view, entry);
  }

  /**
   * Disconnect block inputs.
   * @param {ChainEntry} entry
   * @param {Block} block
   * @returns {Promise<CoinView>}
   */

  async disconnectBlock(entry, block) {
    const view = new CoinView();

    if (this.options.spv)
      return view;

    const hash = block.hash();
    const undo = await this.getUndoCoins(hash);

    this.pending.disconnect(block);

    // Disconnect all transactions.
    for (let i = block.txs.length - 1; i >= 0; i--) {
      const tx = block.txs[i];

      if (i === 0) {
        view.bits.undo(tx);
      } else {
        for (let j = tx.inputs.length - 1; j >= 0; j--) {
          const {prevout} = tx.inputs[j];

          undo.apply(view, prevout);

          const output = view.getOutput(prevout);
          assert(output);

          // REGISTER->REVOKE covenants have no effect.
          if (output.covenant.type >= types.REGISTER
              && output.covenant.type <= types.REVOKE) {
            continue;
          }

          this.pending.add(output);
        }
      }

      // Remove any created coins.
      view.removeTX(tx, entry.height);

      for (let j = tx.outputs.length - 1; j >= 0; j--) {
        const output = tx.outputs[j];

        if (output.isUnspendable())
          continue;

        // Registers are burned.
        if (output.covenant.isRegister())
          this.pending.unburn(output);

        // REGISTER->REVOKE covenants have no effect.
        if (output.covenant.type >= types.REGISTER
            && output.covenant.type <= types.REVOKE) {
          continue;
        }

        // Only remove value from the first claim.
        if (output.covenant.isClaim()) {
          if (output.covenant.getU32(5) !== 1)
            continue;
        }

        this.pending.spend(output);
      }

      // Remove from transaction index.
      this.unindexTX(tx, view);
    }

    // Undo coins should be empty.
    assert(undo.isEmpty(), 'Undo coins data inconsistency.');

    // Commit new coin state.
    this.saveView(view);

    this.blocksBatch.pruneUndo(hash);

    // Connect name state.
    await this.disconnectNames(view, entry);

    return view;
  }

  /**
   * Prune a block from the chain and
   * add current block to the prune queue.
   * @private
   * @param {ChainEntry} entry
   * @returns {Promise<void>}
   */

  async pruneBlock(entry) {
    if (this.options.spv)
      return;

    if (!this.options.prune)
      return;

    const height = entry.height - this.network.block.keepBlocks;

    if (height <= this.network.block.pruneAfterHeight)
      return;

    const hash = await this.getHash(height);

    if (!hash)
      return;

    this.blocksBatch.pruneUndo(hash);
    this.blocksBatch.pruneBlock(hash);
  }

  /**
   * Save database options.
   * @returns {Promise<void>}
   */

  saveFlags() {
    const b = this.db.batch();
    this.writeFlags(b);
    return b.write();
  }

  /**
   * Write database options.
   * @param {Batch} b
   */

  writeFlags(b) {
    const flags = ChainFlags.fromOptions(this.options);
    b.put(layout.O.encode(), flags.encode());
  }

  /**
   * Index a transaction by txid and address.
   * @private
   * @param {TX} tx
   * @param {CoinView} view
   * @param {ChainEntry} entry
   * @param {Number} index
   */

  indexTX(tx, view, entry, index) {
    const hash = tx.hash();

    if (this.options.indexTX) {
      const meta = TXMeta.fromTX(tx, entry, index);

      this.put(layout.t.encode(hash), meta.encode());

      if (this.options.indexAddress) {
        for (const addr of tx.getHashes(view))
          this.put(layout.T.encode(addr, hash), null);
      }
    }

    if (!this.options.indexAddress)
      return;

    if (!tx.isCoinbase()) {
      for (const {prevout} of tx.inputs) {
        const {hash, index} = prevout;
        const coin = view.getOutput(prevout);
        assert(coin);

        const addr = coin.getHash();

        if (!addr)
          continue;

        this.del(layout.C.encode(addr, hash, index));
      }
    }

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const addr = output.getHash();

      if (!addr)
        continue;

      this.put(layout.C.encode(addr, hash, i), null);
    }
  }

  /**
   * Remove transaction from index.
   * @private
   * @param {TX} tx
   * @param {CoinView} view
   */

  unindexTX(tx, view) {
    const hash = tx.hash();

    if (this.options.indexTX) {
      this.del(layout.t.encode(hash));
      if (this.options.indexAddress) {
        for (const addr of tx.getHashes(view))
          this.del(layout.T.encode(addr, hash));
      }
    }

    if (!this.options.indexAddress)
      return;

    if (!tx.isCoinbase()) {
      for (const {prevout} of tx.inputs) {
        const {hash, index} = prevout;
        const coin = view.getOutput(prevout);
        assert(coin);

        const addr = coin.getHash();

        if (!addr)
          continue;

        this.put(layout.C.encode(addr, hash, index), null);
      }
    }

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];
      const addr = output.getHash();

      if (!addr)
        continue;

      this.del(layout.C.encode(addr, hash, i));
    }
  }
}

/*
 * Helpers
 */

function fromU32(num) {
  const data = Buffer.allocUnsafe(4);
  data.writeUInt32LE(num, 0);
  return data;
}

/*
 * Expose
 */

module.exports = ChainDB;
