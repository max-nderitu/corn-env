import { Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import * as pMap from 'p-map'
import * as WebTorrent from 'webtorrent-hybrid'
import { Torrent, Instance as WebTorrentInstance } from 'webtorrent'
import { Episode, Movie, Download } from '@pct-org/mongo-models'
import * as rimraf from 'rimraf'

import { ConfigService } from '../config/config.service'
import { formatKbToString } from '../utils'
import { TorrentInterface, ConnectingTorrentInterface } from './torrent.interface'
import { SubtitlesService } from '../subtitles/subtitles.service'

@Injectable()
export class TorrentService {

  public static STATUS_QUEUED = 'queued'
  public static STATUS_DOWNLOADING = 'downloading'
  public static STATUS_CONNECTING = 'connecting'
  public static STATUS_COMPLETE = 'complete'
  public static STATUS_FAILED = 'failed'
  public static STATUS_REMOVED = 'removed'

  public static TYPE_DOWNLOAD = 'download'
  public static TYPE_STREAM = 'stream'

  private readonly logger = new Logger(TorrentService.name)

  /**
   * Maximum of concurrent downloads in the background
   */
  private readonly maxConcurrent

  /**
   * Array of downloads that will be downloaded in the background
   */
  public downloads: Download[] = []

  /**
   * Are we currently downloading in the background
   */
  private backgroundDownloading = false

  /**
   * Items currently downloading
   */
  public torrents: TorrentInterface[] = []

  /**
   * Items currently connecting
   */
  public connectingTorrents: ConnectingTorrentInterface[] = []

  /**
   * WebTorrent engine
   */
  private webTorrent: WebTorrentInstance = null

  /**
   * All the different supported formats
   */
  public supportedFormats: string[] = ['mp4', 'ogg', 'mov', 'webmv', 'mkv', 'wmv', 'avi']

  private trackers: string[] = [
    'udp://glotorrents.pw:6969',
    'udp://tracker.opentrackr.org:1337',
    'udp://torrent.gresille.org:80',
    'udp://tracker.openbittorrent.com:1337',
    'udp://tracker.coppersurfer.tk:6969',
    'udp://tracker.leechers-paradise.org:6969',
    'udp://p4p.arenabg.ch:1337',
    'udp://p4p.arenabg.com:1337',
    'udp://tracker.internetwarriors.net:1337',
    'udp://9.rarbg.to:2710',
    'udp://9.rarbg.me:2710',
    'udp://exodus.desync.com:6969',
    'udp://tracker.cyberia.is:6969',
    'udp://tracker.torrent.eu.org:451',
    'udp://tracker.open-internet.nl:6969',
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.btorrent.xyz'
  ]

  constructor(
    @InjectModel('Movies') private readonly movieModel: Model<Movie>,
    @InjectModel('Episodes') private readonly episodeModel: Model<Episode>,
    @InjectModel('Downloads') private readonly downloadModel: Model<Download>,
    private readonly configService: ConfigService,
    private readonly subtitlesService: SubtitlesService
  ) {
    this.maxConcurrent = this.configService.get(ConfigService.MAX_CONCURRENT_DOWNLOADS)

    // Check for incomplete downloads and add them to the downloads
    this.checkForIncompleteDownloads()
  }

  /**
   * Sets up web torrent client
   *
   * @param wasCrash
   */
  private setupWebTorrent(wasCrash = false) {
    // If there is already a instance we don't need to do anything
    if (this.webTorrent !== null) {
      return
    }

    this.logger.log('Creating new WebTorrent client')

    this.webTorrent = new WebTorrent({
      maxConns: 55 // Is the default
    })

    this.webTorrent.on('error', (err) => {
      const error = err instanceof Error ? err.message : err
      this.logger.error('Webtorrent threw error', error)

      this.backgroundDownloading = false
      this.setupWebTorrent(true)
    })

    // We are recreating from a crash so also start the downloads again
    if (wasCrash) {
      this.startDownloads()
    }
  }

  /**
   * Cleanup / destroy WebTorrent when there are not downloads / torrents left
   */
  private cleanupWebTorrent(): void {
    // Check if we have a client, downloads and torrents if not then destroy the client
    if (this.webTorrent && this.connectingTorrents.length === 0 && this.torrents.length === 0 && this.downloads.length === 0) {
      this.webTorrent?.destroy((err) => {
        if (err) {
          this.logger.error('Error cleaning up WebTorrent', err.toString())

        } else {
          this.logger.log('No torrents left, WebTorrent client destroyed')
        }
      })

      this.webTorrent = null
    }
  }

  /**
   * Starts the streaming process of one item
   *
   * @param download
   */
  public startStreaming(download: Model<Download>): void {
    this.logger.log(`[${download._id}]: Start streaming`)

    this.download(download)
  }

  /**
   * Starts the streaming process of one item
   *
   * @param download
   */
  public stopDownloading(download: Download): Promise<any> {
    return new Promise((resolve) => {
      const connectingTorrent = this.getConnectingTorrentForDownload(download)
      const downloadingTorrent = this.getTorrentForDownload(download)

      // If we have a connecting torrent and don't have a downloading torrent
      // then stop connecting and cleanup
      if (connectingTorrent && !downloadingTorrent) {
        this.logger.log(`[${download._id}]: Stop connecting`)

        // Remove the magnet from the client
        connectingTorrent.torrent.destroy((err) => {
          if (err) {
            this.logger.error(`[${download._id}]: Error destroying connecting torrent`, err.toString())
          }
        })

        this.removeFromTorrents(download)

        connectingTorrent.resolve()

        return resolve()
      }

      if (!downloadingTorrent) {
        return resolve()
      }

      this.logger.log(`[${download._id}]: Stop downloading`)

      // Destroy the torrent
      downloadingTorrent.torrent.destroy((err) => {
        if (err) {
          this.logger.error(`[${download._id}]: Error destroying downloading torrent`, err.toString())
        }

        this.logger.log(`[${download._id}]: Stopped download`)

        // Remove the magnet from the client
        this.removeFromTorrents(download)

        downloadingTorrent.resolve()
        resolve()
      })
    })
  }

  /**
   * Adds a download to the queued items
   */
  public addDownload(download: Download): void {
    this.downloads.push(download)

    this.logger.log(`[${download._id}]: Added to queue, new size: ${this.downloads.length}`)

    // If the new length is 1 and the flag is still true something went wrong so put it to false
    // and start downloads
    if (this.downloads.length === 1 && this.backgroundDownloading) {
      this.backgroundDownloading = false

      this.startDownloads()
    }
  }

  /**
   * Starts background downloads
   */
  public async startDownloads(): Promise<void> {
    if (this.backgroundDownloading || this.downloads.length === 0) {
      // If start downloads is called and we have no downlaods then also cleanup
      // WebTorrent client to be sure
      if (this.downloads.length === 0) {
        this.cleanupWebTorrent()
      }

      return
    }

    this.logger.log(`Start queued downloads`)

    // Enable that we are downloading
    this.backgroundDownloading = true

    await pMap(
      this.downloads,
      download => this.download(download),
      {
        concurrency: this.maxConcurrent
      }
    )

    // We are no longer downloading to disable
    this.backgroundDownloading = false
    // Cleanup WebTorrent if needed
    this.cleanupWebTorrent()
  }

  /**
   * Set's the downloads that still needs to be done or completed
   */
  private async checkForIncompleteDownloads() {
    this.downloads = await this.downloadModel.find({
      status: {
        $in: [
          TorrentService.STATUS_QUEUED,
          TorrentService.STATUS_CONNECTING,
          TorrentService.STATUS_DOWNLOADING
        ]
      }
    })

    // TODO:: Do something with streams?

    this.logger.log(`Found ${this.downloads.length} downloads`)

    this.startDownloads()
  }

  /**
   * Downloads one item
   *
   * @param {Download} download - Item to download
   */
  private async download(download: Download): Promise<void> {
    // Make sure WebTorrent is setup
    this.setupWebTorrent()

    return new Promise((async (resolve) => {
      this.logger.log(`[${download._id}]: Start download`)

      // Check if the download still exists and has not been deleted in the meanwhile
      const downloadStillExists = this.downloads.find(down => down._id === download._id)

      if (!downloadStillExists) {
        this.logger.log(`[${download._id}]: Download was removed, skipping`)

        return resolve()
      }

      const downloadIsAlreadyConnecting = !!this.getConnectingTorrentForDownload(download)
      const downloadIsAlreadyDownloading = !!this.getTorrentForDownload(download)

      // Prevents the item from being added twice
      if (downloadIsAlreadyConnecting || downloadIsAlreadyDownloading) {
        this.logger.log(`[${download._id}]: Download is already going`)

        return resolve()
      }

      const item = await this.getItemForDownload(download)

      const { torrents, searchedTorrents } = item

      // Find the correct magnet
      const magnet = (
        // If it's null or default then use the normal scraped torrents
        download.torrentType === 'scraped' || download.torrentType === null
          ? torrents
          : searchedTorrents
      ).find(torrent => torrent.quality === download.quality)

      // Check if we have a magnet to be sure
      if (!magnet) {
        await this.updateToStatusFailed(download, item)

        // Resolve instead of reject as no try catch is around the method
        return resolve()
      }

      // Update item that we are connecting
      await this.updateOne(item, {
        download: {
          downloadStatus: TorrentService.STATUS_CONNECTING,
          downloading: true
        }
      })

      // Update the status to connecting
      await this.updateOne(download, {
        status: TorrentService.STATUS_CONNECTING,
        timeRemaining: null,
        speed: null,
        numPeers: null
      })

      const torrent = this.webTorrent.add(
        magnet.url,
        {
          // Add a unique download location for this item
          path: this.getDownloadLocation(download),
          maxWebConns: 5,
          announce: this.trackers
        },
        this.handleTorrent(resolve, item, download)
      )

      // Add to active torrents array
      this.connectingTorrents.push({
        _id: download._id,
        torrent,
        resolve
      })
    }))
  }

  /**
   * Handles the torrent and resolves when the torrent is done
   */
  private handleTorrent(resolve, item, download) {
    return (torrent: Torrent) => {
      // Let's make sure all the not needed files are deselected
      const { file } = torrent.files.reduce((previous, current, index) => {
        const formatIsSupported = !!this.supportedFormats.find(format => current.name.includes(format))

        if (formatIsSupported) {
          if (current.length > previous.file.length) {
            previous.file.deselect()

            return {
              file: current,
              torrentIndex: index
            }
          }
        }

        // Deselect this file
        current.deselect()

        return previous

      }, { file: torrent.files[0], torrentIndex: 0 })

      // Select this file to be the main
      file.select()

      // Add to active torrents array
      this.torrents.push({
        _id: download._id,
        torrent,
        file,
        resolve
      })

      // Now the torrent is added to the active torrents we can remove it from connecting
      this.removeFromTorrents(download, true)

      let searchedSubs = false
      let lastUpdate = null

      // Keep track if we updated the episode of movie with the new status
      let updatedItem = false
      // Keep track if we are currently updating the model, prevents updating same item twice at the same time
      let updatingModel = false

      torrent.on('error', async (err) => {
        const error = err instanceof Error ? err.message : err
        this.logger.error(`[${download._id}]: Torrent error`, error)

        await this.updateToStatusFailed(download, item)

        // Remove from torrents
        this.removeFromTorrents(download)

        // Also cleanup this download
        await this.cleanUpDownload(download)

        // Resolve instead of reject as no try catch is around the method
        resolve()
      })

      torrent.on('noPeers', async (announceType) => {
        this.logger.warn(`[${download._id}]: No peers found, announce type: ${announceType}`)
        await this.updateToStatusFailed(download, item)

        // Remove from torrents
        this.removeFromTorrents(download)

        // Also cleanup this download
        await this.cleanUpDownload(download)

        // Remove the torrent
        torrent.destroy((err) => {
          if (err) {
            this.logger.error(`[${download._id}]: Error destroying torrent in on('noPeers')`, err.toString())
          }
        })

        // Resolve instead of reject as no try catch is around the method
        resolve()
      })

      torrent.on('download', async () => {
        const newProgress = torrent.progress * 100

        // If the last progress is bigger then 0.08 then we have have a file and can search for subs
        if (!searchedSubs && newProgress > 0.08) {
          searchedSubs = true

          // Search and download subs
          this.subtitlesService.searchForSubtitles(download, file)
        }

        const now = Date.now()
        // Only update every 1 second
        if (lastUpdate === null || (lastUpdate + 1000) < now) {
          this.logger.debug(`[${download._id}]: Progress ${newProgress.toFixed(2)}% at ${formatKbToString(torrent.downloadSpeed)} (${torrent.timeRemaining})`)

          lastUpdate = now

          // Don't update if we are already updating
          if (!updatingModel) {
            updatingModel = true

            // Update the item
            await this.updateOne(download, {
              progress: newProgress.toFixed(2),
              status: TorrentService.STATUS_DOWNLOADING,
              timeRemaining: torrent.timeRemaining,
              speed: torrent.downloadSpeed,
              numPeers: torrent.numPeers
            })

            // Update that we are not updating anymore
            updatingModel = false
          }

          if (!updatedItem) {
            updatedItem = true

            // Update item that we are downloading
            await this.updateOne(item, {
              download: {
                downloadStatus: TorrentService.STATUS_DOWNLOADING,
                downloading: true
              }
            })
          }
        }
      })

      torrent.on('done', async () => {
        this.logger.log(`[${download._id}]: Download complete`)

        // Remove the magnet from the client
        torrent.destroy((err) => {
          if (err) {
            this.logger.error(`[${download._id}]: Error destroying torrent in on('done')`, err.toString())
          }
        })

        // Remove from torrents
        this.removeFromTorrents(download)

        // Remove from the queue as the item is downloaded
        this.removeFromDownloads(download)

        // Cleanup WebTorrent if there is nothing left anymore
        this.cleanupWebTorrent()

        // Wait at-least 0,5 second before updating, this is to prevent
        // a double save happening
        setTimeout(async () => {
          await this.updateOne(download, {
            progress: 100,
            status: TorrentService.STATUS_COMPLETE,
            timeRemaining: null,
            speed: null,
            numPeers: null
          })

          await this.updateOne(item, {
            download: {
              downloadStatus: TorrentService.STATUS_COMPLETE,
              downloading: false,
              downloadComplete: true,
              downloadedOn: Number(new Date())
            }
          })
        }, 500)

        // Where done, resolve
        resolve()
      })
    }
  }

  /**
   * Updates download item in the database
   *
   * @param item
   * @param update
   */
  public async updateOne(item: Model<Download | Movie | Episode>, update): Promise<Download | Movie | Episode> {
    // Apply the update
    if (Object.keys(update).length === 1 && update.download) {
      this.logger.debug(`[${item._id}]: Update download info to "${JSON.stringify(update.download)}"`)

      item.download = {
        ...item.download,
        ...update.download
      }

    } else {
      Object.keys(update).forEach((key) => item[key] = update[key])
    }

    item.updatedAt = Number(new Date())

    try {
      // Save the update
      return await item.save()

    } catch (e) {
      this.logger.error(`[${item._id}]: ${e.message || e}`)

      return item
    }
  }

  /**
   * Removes a download from torrents
   */
  private removeFromTorrents(download: Model<Download>, connectingOnly = false) {
    this.connectingTorrents = this.connectingTorrents.filter(tor => tor._id !== download._id)

    if (!connectingOnly) {
      this.torrents = this.torrents.filter(tor => tor._id !== download._id)
    }
  }

  /**
   * Cleans up a download
   */
  public cleanUpDownload(download: Model<Download>, deleteDownload = false): Promise<void> {
    return new Promise(async (resolve) => {
      if (deleteDownload) {
        // Delete the download
        await download.delete()
      }

      const down = this.downloads.find(findDown => findDown._id === download._id)

      if (down) {
        // Remove from array
        this.removeFromDownloads(download)

        this.logger.log(`[${download._id}]: Removed from queue, new size: ${this.downloads.length}`)
      }

      // Remove the download folder
      rimraf(this.getDownloadLocation(download), (error) => {
        if (error) {
          this.logger.error(`[${download._id}]: Error cleaning up`, error.toString())
        }

        resolve()
      })
    })
  }

  /**
   * Returns the item for the download
   *
   * @param download
   */
  public getItemForDownload(download: Download): Promise<Episode | Movie> {
    return (
      download.itemType === 'movie'
        ? this.movieModel
        : this.episodeModel
    ).findById(download._id)
  }

  /**
   * Get's the torrent for the download
   *
   * @param download
   */
  public getTorrentForDownload(download: Download): TorrentInterface {
    return this.torrents.find(torrent => torrent._id === download._id)
  }

  /**
   * Get's the connecting torrent for the download
   *
   * @param download
   */
  public getConnectingTorrentForDownload(download: Download): ConnectingTorrentInterface {
    return this.connectingTorrents.find(torrent => torrent._id === download._id)
  }

  /**
   * Returns the download location for a download
   */
  private getDownloadLocation(download: Download) {
    return `${this.configService.get(ConfigService.DOWNLOAD_LOCATION)}/${download._id}`
  }

  /**
   * Removes a downlaod from the downloads
   */
  private removeFromDownloads(download: Download) {
    this.downloads = this.downloads.filter(filterDown => filterDown._id !== download._id)
  }

  /**
   * Updates the download and item to status failed
   */
  private async updateToStatusFailed(download: Download, item) {
    // No magnet found, update status to failed
    await this.updateOne(download, {
      status: TorrentService.STATUS_FAILED
    })

    await this.updateOne(item, {
      download: {
        downloadStatus: TorrentService.STATUS_FAILED,
        downloading: false
      }
    })
  }

}
