/* eslint-env mocha */
'use strict'

const chai = require('chai')
const dirtyChai = require('dirty-chai')
const pull = require('pull-stream/pull')
const drain = require('pull-stream/sinks/drain')
const parallel = require('async/parallel')
const DaemonFactory = require('ipfsd-ctl')
const isNode = require('detect-node')

const expect = chai.expect
chai.use(dirtyChai)
const df = DaemonFactory.create({ exec: 'src/cli/bin.js' })

const config = {
  Bootstrap: [],
  Discovery: {
    MDNS: {
      Enabled:
        false
    }
  }
}

function spawnNode ({ dht = false }, cb) {
  const args = dht ? ['--enable-dht-experiment'] : []
  df.spawn({
    args,
    config,
    initOptions: { bits: 512 }
  }, cb)
}

describe('ping', function () {
  this.timeout(60 * 1000)

  if (!isNode) return

  describe('DHT disabled', function () {
    // Without DHT nodes need to be previously connected
    let ipfsdA
    let ipfsdB
    let bMultiaddr
    let ipfsdBId

    // Spawn nodes
    before(function (done) {
      this.timeout(60 * 1000)

      parallel([
        spawnNode.bind(null, { dht: false }),
        spawnNode.bind(null, { dht: false })
      ], (err, ipfsd) => {
        expect(err).to.not.exist()
        ipfsdA = ipfsd[0]
        ipfsdB = ipfsd[1]
        done()
      })
    })

    // Get the peer info object
    before(function (done) {
      this.timeout(60 * 1000)

      ipfsdB.api.id((err, peerInfo) => {
        expect(err).to.not.exist()
        ipfsdBId = peerInfo.id
        bMultiaddr = peerInfo.addresses[0]
        done()
      })
    })

    // Connect the nodes
    before(function (done) {
      this.timeout(60 * 1000)
      ipfsdA.api.swarm.connect(bMultiaddr, done)
    })

    after((done) => ipfsdA.stop(done))
    after((done) => ipfsdB.stop(done))

    it('sends the specified number of packets', (done) => {
      let packetNum = 0
      const count = 3
      pull(
        ipfsdA.api.pingPullStream(ipfsdBId, { count }),
        drain(({ success, time, text }) => {
          expect(success).to.be.true()
          // It's a pong
          if (time) {
            packetNum++
          }
        }, (err) => {
          expect(err).to.not.exist()
          expect(packetNum).to.equal(count)
          done()
        })
      )
    })

    it('pinging an unknown peer will fail accordingly', (done) => {
      let messageNum = 0
      const count = 2
      pull(
        ipfsdA.api.pingPullStream('unknown', { count }),
        drain(({ success, time, text }) => {
          messageNum++
          // Assert that the ping command falls back to the peerRouting
          if (messageNum === 1) {
            expect(text).to.include('Looking up')
          }

          // Fails accordingly while trying to use peerRouting
          if (messageNum === 2) {
            expect(success).to.be.false()
          }
        }, (err) => {
          expect(err).to.not.exist()
          expect(messageNum).to.equal(count)
          done()
        })
      )
    })
  })

  describe('DHT enabled', function () {
    // Our bootstrap process will run 3 IPFS daemons where
    // A ----> B ----> C
    // Allowing us to test the ping command using the DHT peer routing
    let ipfsdA
    let ipfsdB
    let ipfsdC
    let bMultiaddr
    let cMultiaddr
    let ipfsdCId

    // Spawn nodes
    before(function (done) {
      this.timeout(60 * 1000)

      parallel([
        spawnNode.bind(null, { dht: true }),
        spawnNode.bind(null, { dht: true }),
        spawnNode.bind(null, { dht: true })
      ], (err, ipfsd) => {
        expect(err).to.not.exist()
        ipfsdA = ipfsd[0]
        ipfsdB = ipfsd[1]
        ipfsdC = ipfsd[2]
        done()
      })
    })

    // Get the peer info objects
    before(function (done) {
      this.timeout(60 * 1000)

      parallel([
        ipfsdB.api.id.bind(ipfsdB.api),
        ipfsdC.api.id.bind(ipfsdC.api)
      ], (err, peerInfo) => {
        expect(err).to.not.exist()
        bMultiaddr = peerInfo[0].addresses[0]
        ipfsdCId = peerInfo[1].id
        cMultiaddr = peerInfo[1].addresses[0]
        done()
      })
    })

    // Connect the nodes
    before(function (done) {
      this.timeout(30 * 1000)
      let interval

      // Check to see if peers are already connected
      const checkConnections = () => {
        ipfsdB.api.swarm.peers((err, peerInfos) => {
          if (err) return done(err)

          if (peerInfos.length > 1) {
            clearInterval(interval)
            return done()
          }
        })
      }

      parallel([
        ipfsdA.api.swarm.connect.bind(ipfsdA.api, bMultiaddr),
        ipfsdB.api.swarm.connect.bind(ipfsdB.api, cMultiaddr)
      ], (err) => {
        if (err) return done(err)
        interval = setInterval(checkConnections, 300)
      })
    })

    after((done) => ipfsdA.stop(done))
    after((done) => ipfsdB.stop(done))
    after((done) => ipfsdC.stop(done))

    it('if enabled uses the DHT peer routing to find peer', (done) => {
      let messageNum = 0
      let packetNum = 0
      const count = 3
      pull(
        ipfsdA.api.pingPullStream(ipfsdCId, { count }),
        drain(({ success, time, text }) => {
          messageNum++
          expect(success).to.be.true()
          // Assert that the ping command falls back to the peerRouting
          if (messageNum === 1) {
            expect(text).to.include('Looking up')
          }
          // It's a pong
          if (time) {
            packetNum++
          }
        }, (err) => {
          expect(err).to.not.exist()
          expect(packetNum).to.equal(count)
          done()
        })
      )
    })
  })
})
