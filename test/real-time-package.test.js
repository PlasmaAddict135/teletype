const assert = require('assert')
const {allowUnsafeEval} = require('loophole')

const RealTimePackage = require('../lib/real-time-package')

const deepEqual = require('deep-equal')
const fs = require('fs')
const path = require('path')
const suiteSetup = global.before
const suiteTeardown = global.after
const setup = global.beforeEach
const teardown = global.afterEach
const suite = global.describe
const test = global.it
const temp = require('temp').track()

suite('RealTimePackage', () => {
  let testServer, containerElement, portals, conditionErrorMessage

  suiteSetup(async () => {
    // Bypass CSP errors caused by an Express.js dependency.
    // TODO: Remove this once Atom 1.20 reaches stable.
    let testServerPromise
    allowUnsafeEval(() => {
      const {startTestServer} = require('@atom/real-time-server')
      testServerPromise = startTestServer({
        databaseURL: 'postgres://localhost:5432/real-time-server-test',
        // Uncomment and provide credentials to test against Pusher.
        // pusherCredentials: {
        //   appId: '123',
        //   key: '123',
        //   secret: '123'
        // }
      })
    })
    testServer = await testServerPromise
  })

  suiteTeardown(() => {
    return testServer.stop()
  })

  setup(() => {
    conditionErrorMessage = null
    portals = []
    containerElement = document.createElement('div')
    document.body.appendChild(containerElement)

    return testServer.reset()
  })

  teardown(async () => {
    if (conditionErrorMessage) {
      console.error('Condition failed with error message: ', conditionErrorMessage)
    }

    containerElement.remove()
    for (const portal of portals) {
      await portal.dispose()
    }
  })

  test('sharing and joining a portal', async function () {
    const hostEnv = buildAtomEnvironment()
    const hostPackage = buildPackage(hostEnv)
    const guestEnv = buildAtomEnvironment()
    const guestPackage = buildPackage(guestEnv)
    const portalId = (await hostPackage.sharePortal()).id

    guestPackage.joinPortal(portalId)

    const hostEditor1 = await hostEnv.workspace.open(temp.path({extension: '.js'}))
    hostEditor1.setText('const hello = "world"')
    hostEditor1.setCursorBufferPosition([0, 4])

    await condition(() => guestEnv.workspace.getActiveTextEditor() != null)
    const guestEditor1 = guestEnv.workspace.getActiveTextEditor()
    assert.equal(guestEditor1.getText(), 'const hello = "world"')
    assert.equal(guestEditor1.getTitle(), `Remote Buffer: ${hostEditor1.getTitle()}`)
    assert(!guestEditor1.isModified())
    await condition(() => deepEqual(getCursorDecoratedRanges(hostEditor1), getCursorDecoratedRanges(guestEditor1)))

    hostEditor1.setSelectedBufferRanges([
      [[0, 0], [0, 2]],
      [[0, 4], [0, 6]]
    ])
    guestEditor1.setSelectedBufferRanges([
      [[0, 1], [0, 3]],
      [[0, 5], [0, 7]]
    ])
    await condition(() => deepEqual(getCursorDecoratedRanges(hostEditor1), getCursorDecoratedRanges(guestEditor1)))

    assert(guestPackage.bindingForEditor(guestEditor1).isFollowingHostCursor())
    guestPackage.toggleFollowHostCursor(guestEditor1)
    assert(!guestPackage.bindingForEditor(guestEditor1).isFollowingHostCursor())

    const hostEditor2 = await hostEnv.workspace.open(temp.path({extension: '.md'}))
    hostEditor2.setText('# Hello, World')
    hostEditor2.setCursorBufferPosition([0, 2])

    await condition(() => guestEnv.workspace.getActiveTextEditor() !== guestEditor1)
    const guestEditor2 = guestEnv.workspace.getActiveTextEditor()
    assert.equal(guestEditor2.getText(), '# Hello, World')
    assert.equal(guestEditor2.getTitle(), `Remote Buffer: ${hostEditor2.getTitle()}`)
    await condition(() => deepEqual(getCursorDecoratedRanges(hostEditor2), getCursorDecoratedRanges(guestEditor2)))
  })

  test('preserving guest portal position in workspace', async function () {
    const hostEnv = buildAtomEnvironment()
    const hostPackage = buildPackage(hostEnv)

    const guestEnv = buildAtomEnvironment()
    const guestPackage = buildPackage(guestEnv)

    await guestEnv.workspace.open(path.join(temp.path(), 'guest-1'))

    const portalId = (await hostPackage.sharePortal()).id
    await guestPackage.joinPortal(portalId)

    const hostEditor1 = await hostEnv.workspace.open(path.join(temp.path(), 'host-1'))
    await condition(() => guestEnv.workspace.getActiveTextEditor().getTitle() === 'Remote Buffer: host-1')

    await guestEnv.workspace.open(path.join(temp.path(), 'guest-2'))
    assert.deepEqual(guestEnv.workspace.getPaneItems().map((i) => i.getTitle()), ['guest-1', 'Remote Buffer: host-1', 'guest-2'])

    await hostEnv.workspace.open(path.join(temp.path(), 'host-2'))
    await condition(() => deepEqual(guestEnv.workspace.getPaneItems().map((i) => i.getTitle()), ['guest-1', 'Remote Buffer: host-2', 'guest-2']))

    hostEnv.workspace.paneForItem(hostEditor1).activateItem(hostEditor1)
    await condition(() => deepEqual(guestEnv.workspace.getPaneItems().map((i) => i.getTitle()), ['guest-1', 'Remote Buffer: host-1', 'guest-2']))
  })

  test('closing guest portal editor when last editor is closed in host workspace', async function() {
    const hostEnv = buildAtomEnvironment()
    const hostPackage = buildPackage(hostEnv)
    const guestEnv = buildAtomEnvironment()
    const guestPackage = buildPackage(guestEnv)
    const portalId = (await hostPackage.sharePortal()).id

    await guestPackage.joinPortal(portalId)

    const hostEditor1 = await hostEnv.workspace.open(path.join(temp.path(), 'some-file'))
    await condition(() => guestEnv.workspace.getActiveTextEditor() != null)
    assert.equal(guestEnv.workspace.getActiveTextEditor().getTitle(), 'Remote Buffer: some-file')

    hostEnv.workspace.closeActivePaneItemOrEmptyPaneOrWindow()
    await condition(() => guestEnv.workspace.getActiveTextEditor() == null)

    await hostEnv.workspace.open(path.join(temp.path(), 'some-file'))
    await condition(() => guestEnv.workspace.getActiveTextEditor() != null)
    assert.equal(guestEnv.workspace.getActiveTextEditor().getTitle(), 'Remote Buffer: some-file')
  })

  test('host disconnecting', async function () {
    const HEARTBEAT_INTERVAL_IN_MS = 10
    const EVICTION_PERIOD_IN_MS = 2 * HEARTBEAT_INTERVAL_IN_MS
    testServer.heartbeatService.setEvictionPeriod(EVICTION_PERIOD_IN_MS)

    const hostEnv = buildAtomEnvironment()
    const hostPackage = buildPackage(hostEnv, {heartbeatIntervalInMilliseconds: HEARTBEAT_INTERVAL_IN_MS})
    const guestEnv = buildAtomEnvironment()
    const guestPackage = buildPackage(guestEnv, {heartbeatIntervalInMilliseconds: HEARTBEAT_INTERVAL_IN_MS})
    const hostPortal = await hostPackage.sharePortal()

    await guestPackage.joinPortal(hostPortal.id)

    const hostEditor1 = await hostEnv.workspace.open(path.join(temp.path(), 'file-1'))
    hostEditor1.setText('const hello = "world"')
    hostEditor1.setCursorBufferPosition([0, 4])
    await condition(() => guestEnv.workspace.getActiveTextEditor() != null)

    const hostEditor2 = await hostEnv.workspace.open(path.join(temp.path(), 'file-2'))
    hostEditor2.setText('const goodnight = "moon"')
    hostEditor2.setCursorBufferPosition([0, 2])
    await condition(() => guestEnv.workspace.getActiveTextEditor().getTitle() === 'Remote Buffer: file-2')

    const guestEditor = guestEnv.workspace.getActiveTextEditor()
    await condition(() => deepEqual(getCursorDecoratedRanges(hostEditor2), getCursorDecoratedRanges(guestEditor)))
    guestEditor.setCursorBufferPosition([0, 5])

    const guestEditorTitleChangeEvents = []
    guestEditor.onDidChangeTitle((title) => guestEditorTitleChangeEvents.push(title))

    await hostPortal.simulateNetworkFailure()
    await condition(async () => deepEqual(
      await testServer.heartbeatService.findDeadSites(),
      [{portalId: hostPortal.id, id: hostPortal.siteId}]
    ))
    testServer.heartbeatService.evictDeadSites()
    await condition(() => guestEditor.getTitle() === 'untitled')
    assert.deepEqual(guestEditorTitleChangeEvents, ['untitled'])
    assert.equal(guestEditor.getText(), 'const goodnight = "moon"')
    assert(guestEditor.isModified())
    assert.deepEqual(getCursorDecoratedRanges(guestEditor), [
      {start: {row: 0, column: 5}, end: {row: 0, column: 5}}
    ])
  })

  function buildPackage (env, {heartbeatIntervalInMilliseconds} = {}) {
    return new RealTimePackage({
      restGateway: testServer.restGateway,
      pubSubGateway: testServer.pubSubGateway,
      workspace: env.workspace,
      notificationManager: env.notifications,
      commandRegistry: env.commands,
      clipboard: new FakeClipboard(),
      heartbeatIntervalInMilliseconds,
      didCreateOrJoinPortal: (portal) => portals.push(portal)
    })
  }

  function condition (fn, message) {
    assert(!conditionErrorMessage, 'Cannot await on multiple conditions at the same time')

    conditionErrorMessage = message
    return new Promise((resolve) => {
      async function callback () {
        const resultOrPromise = fn()
        const result = (resultOrPromise instanceof Promise) ? (await resultOrPromise) : resultOrPromise
        if (result) {
          conditionErrorMessage = null
          resolve()
        } else {
          setTimeout(callback, 5)
        }
      }

      callback()
    })
  }
})

function getCursorDecoratedRanges (editor) {
  const {decorationManager} = editor
  const decorationsByMarker = decorationManager.decorationPropertiesByMarkerForScreenRowRange(0, Infinity)
  const ranges = []
  for (const [marker, decorations] of decorationsByMarker) {
    const hasCursorDecoration = decorations.some((d) => d.type === 'cursor')
    if (hasCursorDecoration) ranges.push(marker.getBufferRange())
  }
  return ranges.sort((a, b) => a.compare(b))
}

class FakeClipboard {
  constructor () {
    this.text = null
  }

  read () {
    return this.text
  }

  write (text) {
    this.text = text
  }
}
