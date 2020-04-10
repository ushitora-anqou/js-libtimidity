const LibTimidity = require('./libtimidity.js')

const AUDIO_FORMAT = 0x8010 // format of the rendered audio 's16'
const BUFFER_SIZE = 16384 // buffer size for each render() call

class JSLibTimidity {
  constructor (baseUrl, timidityCfg, { sampleRate, numChannels }) {
    if (!baseUrl.endsWith('/')) baseUrl += '/'
    this._baseUrl = new URL(baseUrl, window.location.origin).href

    this._sampleRate = sampleRate || 44100
    this._numChannels = numChannels || 2
    this._bytesPerSample = 2 * this._numChannels
    this._pendingFetches = {} // instrument -> fetch
    this._libReady = false
    this._timidityCfg = timidityCfg

    this._lib = LibTimidity({
      locateFile: file => new URL(file, this._baseUrl).href,
      onRuntimeInitialized: () => this._onLibReady()
    })
  }

  isReady () {
    return this._libReady
  }

  _onLibReady () {
    this._lib.FS.writeFile('/timidity.cfg', this._timidityCfg)

    const result = this._lib._mid_init('/timidity.cfg')
    if (result !== 0) {
      throw new Error('Failed to initialize libtimidity')
    }

    this._libReady = true
  }

  async midi2wav (midiBuf) {
    if (!(midiBuf instanceof Uint8Array))
      throw new Error('Expects a `Uint8Array` argument')
    if (!this.isReady()) throw new Error('libtimidity is not ready')

    // Load
    let songPtr = this._loadSong(midiBuf)
    // Are we missing instrument files?
    let missingCount = this._lib._mid_get_load_request_count(songPtr)
    if (missingCount > 0) {
      let missingInstruments = this._getMissingInstruments(
        songPtr,
        missingCount
      )

      // Wait for all instruments to load
      await Promise.all(
        missingInstruments.map(instrument => this._fetchInstrument(instrument))
      )

      // Retry the song load, now that instruments have been loaded
      this._lib._mid_song_free(songPtr)
      songPtr = this._loadSong(midiBuf)
    }

    // Start
    this._lib._mid_song_start(songPtr)

    // Read
    const bufferPtr = this._lib._malloc(BUFFER_SIZE * this._bytesPerSample)
    const outputBuf = []
    while (true) {
      const byteCount = this._lib._mid_song_read_wave(
        songPtr,
        bufferPtr,
        BUFFER_SIZE * this._bytesPerSample
      )
      const sampleCount = byteCount / this._bytesPerSample

      // Was anything output? If not, don't bother copying anything
      if (sampleCount === 0) break

      const array = new Int16Array(BUFFER_SIZE * 2)
      array.set(
        this._lib.HEAP16.subarray(bufferPtr / 2, (bufferPtr + byteCount) / 2)
      )
      outputBuf.push(array)
    }

    // Concat buf
    const totalSize = outputBuf.reduce((acc, buf) => acc + buf.length, 0)
    const output = new Int16Array(totalSize)
    let offset = 0
    for (let buf of outputBuf) {
      output.set(buf, offset)
      offset += buf.length
    }

    // Clean up
    this._lib._mid_song_free(songPtr)
    this._lib._free(bufferPtr)

    return {
      sampleRate: this._sampleRate,
      numChannels: this._numChannels,
      data: output
    }
  }

  _loadSong (midiBuf) {
    const optsPtr = this._lib._mid_alloc_options(
      this._sampleRate,
      AUDIO_FORMAT,
      this._numChannels,
      BUFFER_SIZE
    )

    // Copy the MIDI buffer into the heap
    const midiBufPtr = this._lib._malloc(midiBuf.byteLength)
    this._lib.HEAPU8.set(midiBuf, midiBufPtr)

    // Create a stream
    const iStreamPtr = this._lib._mid_istream_open_mem(
      midiBufPtr,
      midiBuf.byteLength
    )

    // Load the song
    const songPtr = this._lib._mid_song_load(iStreamPtr, optsPtr)

    // Free resources no longer needed
    this._lib._mid_istream_close(iStreamPtr)
    this._lib._free(optsPtr)
    this._lib._free(midiBufPtr)

    if (songPtr === 0) {
      throw new Error('Failed to load MIDI file')
    }

    return songPtr
  }

  _getMissingInstruments (songPtr, missingCount) {
    const missingInstruments = []
    for (let i = 0; i < missingCount; i++) {
      const instrumentPtr = this._lib._mid_get_load_request(songPtr, i)
      const instrument = this._lib.UTF8ToString(instrumentPtr)
      missingInstruments.push(instrument)
    }
    return missingInstruments
  }

  async _fetchInstrument (instrument) {
    if (this._pendingFetches[instrument]) {
      // If this instrument is already in the process of being fetched, return
      // the existing promise to prevent duplicate fetches.
      return this._pendingFetches[instrument]
    }

    const url = new URL(instrument, this._baseUrl)
    const bufPromise = this._fetch(url)
    this._pendingFetches[instrument] = bufPromise

    const buf = await bufPromise
    this._writeInstrumentFile(instrument, buf)

    delete this._pendingFetches[instrument]

    return buf
  }

  async _fetch (url) {
    const opts = {
      mode: 'cors',
      credentials: 'same-origin'
    }
    const response = await window.fetch(url, opts)
    if (response.status !== 200) throw new Error(`Could not load ${url}`)

    const arrayBuffer = await response.arrayBuffer()
    const buf = new Uint8Array(arrayBuffer)
    return buf
  }

  _writeInstrumentFile (instrument, buf) {
    const folderPath = instrument
      .split('/')
      .slice(0, -1) // remove basename
      .join('/')
    this._mkdirp(folderPath)
    this._lib.FS.writeFile(instrument, buf, { encoding: 'binary' })
  }

  _mkdirp (folderPath) {
    const pathParts = folderPath.split('/')
    let dirPath = '/'
    for (let i = 0; i < pathParts.length; i++) {
      const curPart = pathParts[i]
      try {
        this._lib.FS.mkdir(`${dirPath}${curPart}`)
      } catch (err) {}
      dirPath += `${curPart}/`
    }
  }
}

export default JSLibTimidity
