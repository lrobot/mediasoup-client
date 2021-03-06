const sdpTransform = require('sdp-transform');
const Logger = require('../Logger');
const EnhancedEventEmitter = require('../EnhancedEventEmitter');
const { UnsupportedError, DuplicatedError } = require('../errors');
const utils = require('../utils');
const ortc = require('../ortc');
const sdpCommonUtils = require('./sdp/commonUtils');
const sdpUnifiedPlanUtils = require('./sdp/unifiedPlanUtils');
const RemoteUnifiedPlanSdp = require('./sdp/RemoteUnifiedPlanSdp');

const logger = new Logger('Firefox60');

class Handler extends EnhancedEventEmitter
{
	constructor(
		{
			transportRemoteParameters,
			iceServers,
			iceTransportPolicy,
			proprietaryConstraints,
			sendingRtpParametersByKind
		}
	)
	{
		super(logger);

		// Generic sending RTP parameters for audio and video.
		// @type {Object}
		this._sendingRtpParametersByKind = sendingRtpParametersByKind;

		// Got transport local and remote parameters.
		// @type {Boolean}
		this._transportReady = false;

		// Remote SDP handler.
		// @type {RemoteUnifiedPlanSdp}
		this._remoteSdp = new RemoteUnifiedPlanSdp(
			{
				transportRemoteParameters,
				sendingRtpParametersByKind
			});

		// RTCPeerConnection instance.
		// @type {RTCPeerConnection}
		this._pc = new RTCPeerConnection(
			{
				iceServers         : iceServers || [],
				iceTransportPolicy : iceTransportPolicy || 'all',
				bundlePolicy       : 'max-bundle',
				rtcpMuxPolicy      : 'require'
			},
			proprietaryConstraints);

		// Handle RTCPeerConnection connection status.
		this._pc.addEventListener('iceconnectionstatechange', () =>
		{
			switch (this._pc.iceConnectionState)
			{
				case 'checking':
					this.emit('@connectionstatechange', 'connecting');
					break;
				case 'connected':
				case 'completed':
					this.emit('@connectionstatechange', 'connected');
					break;
				case 'failed':
					this.emit('@connectionstatechange', 'failed');
					break;
				case 'disconnected':
					this.emit('@connectionstatechange', 'disconnected');
					break;
				case 'closed':
					this.emit('@connectionstatechange', 'closed');
					break;
			}
		});
	}

	close()
	{
		logger.debug('close()');

		// Close RTCPeerConnection.
		try { this._pc.close(); }
		catch (error) {}
	}

	async getTransportStats()
	{
		return this._pc.getStats();
	}

	async updateIceServers({ iceServers }) // eslint-disable-line no-unused-vars
	{
		logger.debug('updateIceServers()');

		// NOTE: Firefox does not implement pc.setConfiguration().
		throw new UnsupportedError('not supported');
	}

	async _setupTransport({ localDtlsRole } = {})
	{
		// Get our local DTLS parameters.
		const sdp = this._pc.localDescription.sdp;
		const sdpObj = sdpTransform.parse(sdp);
		const dtlsParameters = sdpCommonUtils.extractDtlsParameters(sdpObj);

		// Set our DTLS role.
		if (localDtlsRole)
			dtlsParameters.role = localDtlsRole;

		const transportLocalParameters = { dtlsParameters };

		// Need to tell the remote transport about our parameters.
		await this.safeEmitAsPromise('@connect', transportLocalParameters);

		this._transportReady = true;
	}
}

class SendHandler extends Handler
{
	constructor(data)
	{
		super(data);

		// Sending tracks.
		// @type {Set<MediaStreamTrack>}
		this._tracks = new Set();

		// RID value counter for simulcast (so they never match).
		// @type {Number}
		this._nextRid = 1;
	}

	async send({ track, simulcast })
	{
		logger.debug('send() [kind:%s, track.id:%s]', track.kind, track.id);

		if (this._tracks.has(track))
			throw new DuplicatedError('track already handled');

		let transceiver;

		try
		{
			// Let's check if there is any inactive transceiver for same kind and
			// reuse it if so.
			transceiver = this._pc.getTransceivers()
				.find((t) => (
					t.receiver.track.kind === track.kind &&
					t.direction === 'inactive'
				));

			if (transceiver)
			{
				logger.debug('send() | reusing an inactive transceiver');

				transceiver.direction = 'sendonly';

				const rtpSender = transceiver.sender;

				// Must reset encodings in the RtpSender.
				const parameters = rtpSender.getParameters();

				await rtpSender.setParameters({ ...parameters, encodings: [] });
				await rtpSender.replaceTrack(track);
			}
			else
			{
				transceiver = this._pc.addTransceiver(track, { direction: 'sendonly' });
			}

			if (simulcast)
			{
				logger.debug('send() | enabling simulcast');

				const { sender } = transceiver;
				const encodings = [];

				if (simulcast.low)
				{
					encodings.push(
						{
							rid        : `low${this._nextRid}`,
							active     : true,
							priority   : 'high',
							maxBitrate : simulcast.low
						});
				}

				if (simulcast.medium)
				{
					encodings.push(
						{
							rid        : `medium${this._nextRid}`,
							active     : true,
							priority   : 'medium',
							maxBitrate : simulcast.medium
						});
				}

				if (simulcast.high)
				{
					encodings.push(
						{
							rid        : `high${this._nextRid}`,
							active     : true,
							priority   : 'low',
							maxBitrate : simulcast.high
						});
				}

				// Update RID counter for future ones.
				this._nextRid++;

				const parameters = sender.getParameters();
				const newParameters = Object.assign(parameters, { encodings });

				await sender.setParameters(newParameters);
			}

			const offer = await this._pc.createOffer();

			logger.debug(
				'send() | calling pc.setLocalDescription() [offer:%o]',
				offer);

			await this._pc.setLocalDescription(offer);

			// In Firefox use DTLS role client even if we are the "offerer" since
			// Firefox does not respect ICE-Lite.
			if (!this._transportReady)
				await this._setupTransport({ localDtlsRole: 'client' });

			const localSdpObj = sdpTransform.parse(this._pc.localDescription.sdp);
			const remoteSdp = this._remoteSdp.createAnswerSdp(localSdpObj);
			const answer = { type: 'answer', sdp: remoteSdp };

			logger.debug(
				'send() | calling pc.setRemoteDescription() [answer:%o]',
				answer);

			await this._pc.setRemoteDescription(answer);

			const rtpParameters =
				utils.clone(this._sendingRtpParametersByKind[track.kind]);

			sdpUnifiedPlanUtils.fillRtpParametersForTrack(
				rtpParameters,
				localSdpObj,
				track,
				{ mid: transceiver.mid });

			this._tracks.add(track);

			return rtpParameters;
		}
		catch (error)
		{
			// Panic here. Try to undo things.

			try { transceiver.direction = 'inactive'; }
			catch (error2) {}

			throw error;
		}
	}

	async stopSending({ track })
	{
		logger.debug('stopSending() [track.id:%s]', track.id);

		// Get the associated RTCRtpSender.
		const rtpSender = this._pc.getSenders()
			.find((s) => s.track === track);

		if (!rtpSender)
			throw new Error('local track not found');

		this._pc.removeTrack(rtpSender);

		const offer = await this._pc.createOffer();

		logger.debug(
			'stopSending() | calling pc.setLocalDescription() [offer:%o]',
			offer);

		await this._pc.setLocalDescription(offer);

		const localSdpObj = sdpTransform.parse(this._pc.localDescription.sdp);
		const remoteSdp = this._remoteSdp.createAnswerSdp(localSdpObj);
		const answer = { type: 'answer', sdp: remoteSdp };

		logger.debug(
			'stopSending() | calling pc.setRemoteDescription() [answer:%o]',
			answer);

		this._tracks.delete(track);

		await this._pc.setRemoteDescription(answer);
	}

	async replaceTrack({ track, newTrack })
	{
		logger.debug('replaceTrack() [newTrack.id:%s]', newTrack.id);

		if (this._tracks.has(newTrack))
			throw new DuplicatedError('track already handled');

		// Get the associated RTCRtpSender.
		const rtpSender = this._pc.getSenders()
			.find((s) => s.track === track);

		if (!rtpSender)
			throw new Error('local track not found');

		await rtpSender.replaceTrack(newTrack);

		this._tracks.delete(track);
		this._tracks.add(newTrack);
	}

	async setMaxSpatialLayer({ track, spatialLayer })
	{
		logger.debug(
			'setMaxSpatialLayer() [track.id:%s, spatialLayer:%s]',
			track.id, spatialLayer);

		// Get the associated RTCRtpSender.
		const rtpSender = this._pc.getSenders()
			.find((s) => s.track === track);

		if (!rtpSender)
			throw new Error('local track not found');

		const parameters = rtpSender.getParameters();
		const lowEncoding = parameters.encodings[0];
		const mediumEncoding = parameters.encodings[1];
		const highEncoding = parameters.encodings[2];

		switch (spatialLayer)
		{
			case 'low':
			{
				lowEncoding && (lowEncoding.active = true);
				mediumEncoding && (mediumEncoding.active = false);
				highEncoding && (highEncoding.active = false);

				break;
			}

			case 'medium':
			{
				lowEncoding && (lowEncoding.active = true);
				mediumEncoding && (mediumEncoding.active = true);
				highEncoding && (highEncoding.active = false);

				break;
			}

			case 'high':
			{
				lowEncoding && (lowEncoding.active = true);
				mediumEncoding && (mediumEncoding.active = true);
				highEncoding && (highEncoding.active = true);

				break;
			}
		}

		await rtpSender.setParameters(parameters);
	}

	async getSenderStats({ track })
	{
		// Get the associated RTCRtpSender.
		const rtpSender = this._pc.getSenders()
			.find((s) => s.track === track);

		if (!rtpSender)
			throw new Error('local track not found');

		return rtpSender.getStats();
	}

	async restartIce({ remoteIceParameters })
	{
		logger.debug('restartIce()');

		// Provide the remote SDP handler with new remote ICE parameters.
		this._remoteSdp
			.updateTransportRemoteIceParameters(remoteIceParameters);

		if (!this._transportReady)
			return;

		const offer = this._pc.createOffer({ iceRestart: true });

		logger.debug(
			'restartIce() | calling pc.setLocalDescription() [offer:%o]',
			offer);

		await this._pc.setLocalDescription(offer);

		const localSdpObj = sdpTransform.parse(this._pc.localDescription.sdp);
		const remoteSdp = this._remoteSdp.createAnswerSdp(localSdpObj);
		const answer = { type: 'answer', sdp: remoteSdp };

		logger.debug(
			'restartIce() | calling pc.setRemoteDescription() [answer:%o]',
			answer);

		await this._pc.setRemoteDescription(answer);
	}
}

class RecvHandler extends Handler
{
	constructor(data)
	{
		super(data);

		// Map of receivers information indexed by id.
		// - mid {String}
		// - kind {String}
		// - closed {Boolean}
		// - trackId {String}
		// - rtpParameters {RTCRtpParameters}
		// @type {Map<String, Object>}
		this._receiverInfos = new Map();
	}

	async receive({ id, kind, rtpParameters })
	{
		logger.debug('receive() [id:%s, kind:%s]', id, kind);

		if (this._receiverInfos.has(id))
			throw new DuplicatedError('already receiving this source');

		const receiverInfo =
		{
			mid           : `${kind[0]}-${id}`,
			kind          : kind,
			closed        : false,
			streamId      : id,
			trackId       : `${kind}-${id}`,
			rtpParameters : rtpParameters
		};

		this._receiverInfos.set(id, receiverInfo);

		try
		{
			const remoteSdp = this._remoteSdp.createOfferSdp(
				Array.from(this._receiverInfos.values()));
			const offer = { type: 'offer', sdp: remoteSdp };

			logger.debug(
				'receive() | calling pc.setRemoteDescription() [offer:%o]',
				offer);

			await this._pc.setRemoteDescription(offer);
		}
		catch (error)
		{
			// Panic here. Try to undo things.

			this._receiverInfos.delete(id);

			throw error;
		}

		const answer = await this._pc.createAnswer();

		logger.debug(
			'receive() | calling pc.setLocalDescription() [answer:%o]',
			answer);

		await this._pc.setLocalDescription(answer);

		if (!this._transportReady)
			await this._setupTransport({ localDtlsRole: 'client' });

		const transceiver = this._pc.getTransceivers()
			.find((t) => t.mid === receiverInfo.mid);

		if (!transceiver)
			throw new Error('remote track not found');

		return transceiver.receiver.track;
	}

	async stopReceiving({ id })
	{
		logger.debug('stopReceiving() [id:%s]', id);

		const receiverInfo = this._receiverInfos.get(id);

		if (!receiverInfo)
			throw new Error('receiver not found');

		receiverInfo.closed = true;

		const remoteSdp = this._remoteSdp.createOfferSdp(
			Array.from(this._receiverInfos.values()));
		const offer = { type: 'offer', sdp: remoteSdp };

		logger.debug(
			'stopReceiving() | calling pc.setRemoteDescription() [offer:%o]',
			offer);

		await this._pc.setRemoteDescription(offer);

		const answer = this._pc.createAnswer();

		logger.debug(
			'stopReceiving() | calling pc.setLocalDescription() [answer:%o]',
			answer);

		await this._pc.setLocalDescription(answer);
	}

	async getReceiverStats({ id })
	{
		const receiverInfo = this._receiverInfos.get(id);

		if (!receiverInfo)
			throw new Error('receiver not found');

		const { mid } = receiverInfo;

		// Get the associated RTCRtpTransceiver.
		const transceiver = this._pc.getTransceivers()
			.find((t) => t.mid === mid);

		if (!transceiver)
			throw new Error('transceiver not found');

		return transceiver.receiver.getStats();
	}

	async restartIce({ remoteIceParameters })
	{
		logger.debug('restartIce()');

		// Provide the remote SDP handler with new remote ICE parameters.
		this._remoteSdp
			.updateTransportRemoteIceParameters(remoteIceParameters);

		if (!this._transportReady)
			return;

		const remoteSdp = this._remoteSdp.createOfferSdp(
			Array.from(this._receiverInfos.values()));
		const offer = { type: 'offer', sdp: remoteSdp };

		logger.debug(
			'restartIce() | calling pc.setRemoteDescription() [offer:%o]',
			offer);

		await this._pc.setRemoteDescription(offer);

		const answer = this._pc.createAnswer();

		logger.debug(
			'restartIce() | calling pc.setLocalDescription() [answer:%o]',
			answer);

		await this._pc.setLocalDescription(answer);
	}
}

class Firefox60
{
	static async getNativeRtpCapabilities()
	{
		logger.debug('getNativeRtpCapabilities()');

		const pc = new RTCPeerConnection(
			{
				iceServers         : [],
				iceTransportPolicy : 'all',
				bundlePolicy       : 'max-bundle',
				rtcpMuxPolicy      : 'require'
			});

		// NOTE: We need to add a real video track to get the RID extension mapping.
		const canvas = document.createElement('canvas');

		// NOTE: Otherwise Firefox fails in next line.
		canvas.getContext('2d');

		const fakeStream = canvas.captureStream();
		const fakeVideoTrack = fakeStream.getVideoTracks()[0];

		try
		{
			pc.addTransceiver('audio', { direction: 'sendrecv' });

			const videoTransceiver =
				pc.addTransceiver(fakeVideoTrack, { direction: 'sendrecv' });
			const parameters = videoTransceiver.sender.getParameters();
			const encodings =
			[
				{ rid: 'RID1', maxBitrate: 100000 },
				{ rid: 'RID2', maxBitrate: 500000 }
			];
			const newParameters = Object.assign(parameters, { encodings });

			await videoTransceiver.sender.setParameters(newParameters);

			const offer = await pc.createOffer();

			try { canvas.remove(); }
			catch (error) {}

			try { fakeVideoTrack.stop(); }
			catch (error) {}

			try { pc.close(); }
			catch (error) {}

			const sdpObj = sdpTransform.parse(offer.sdp);
			const nativeRtpCapabilities =
				sdpCommonUtils.extractRtpCapabilities(sdpObj);

			return nativeRtpCapabilities;
		}
		catch (error)
		{
			try { canvas.remove(); }
			catch (error2) {}

			try { fakeVideoTrack.stop(); }
			catch (error2) {}

			try { pc.close(); }
			catch (error2) {}

			throw error;
		}
	}

	constructor(
		{
			transportRemoteParameters,
			direction,
			iceServers,
			iceTransportPolicy,
			proprietaryConstraints,
			extendedRtpCapabilities
		}
	)
	{
		logger.debug('constructor() [direction:%s]', direction);

		switch (direction)
		{
			case 'send':
			{
				const sendingRtpParametersByKind =
				{
					audio : ortc.getSendingRtpParameters('audio', extendedRtpCapabilities),
					video : ortc.getSendingRtpParameters('video', extendedRtpCapabilities)
				};

				return new SendHandler(
					{
						transportRemoteParameters,
						iceServers,
						iceTransportPolicy,
						proprietaryConstraints,
						sendingRtpParametersByKind
					});
			}

			case 'recv':
			{
				return new RecvHandler(
					{
						transportRemoteParameters,
						iceServers,
						iceTransportPolicy,
						proprietaryConstraints
					});
			}
		}
	}
}

module.exports = Firefox60;
