const sdpTransform = require('sdp-transform');
const Logger = require('../Logger');
const EnhancedEventEmitter = require('../EnhancedEventEmitter');
const { UnsupportedError, DuplicatedError } = require('../errors');
const utils = require('../utils');
const ortc = require('../ortc');
const sdpCommonUtils = require('./sdp/commonUtils');
const sdpPlanBUtils = require('./sdp/planBUtils');
const RemotePlanBSdp = require('./sdp/RemotePlanBSdp');

const logger = new Logger('Safari11');

class Handler extends EnhancedEventEmitter
{
	constructor(
		{
			transportRemoteParameters,
			iceServers,
			iceTransportPolicy,
			proprietaryConstraints,
			sendingRtpParametersByKind,
			receivingRtpParametersByKind
		}
	)
	{
		super(logger);

		// Generic sending RTP parameters for audio and video.
		// @type {Object}
		this._sendingRtpParametersByKind = sendingRtpParametersByKind;

		// Generic receiving RTP parameters for audio and video.
		// @type {Object}
		this._receivingRtpParametersByKind = receivingRtpParametersByKind;

		// Got transport local and remote parameters.
		// @type {Boolean}
		this._transportReady = false;

		// Remote SDP handler.
		// @type {RemotePlanBSdp}
		this._remoteSdp = new RemotePlanBSdp(
			{
				transportRemoteParameters,
				sendingRtpParametersByKind,
				receivingRtpParametersByKind
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

	async updateIceServers({ iceServers })
	{
		logger.debug('updateIceServers()');

		const configuration = this._pc.getConfiguration();

		configuration.iceServers = iceServers;

		this._pc.setConfiguration(configuration);
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

		// Local stream.
		// @type {MediaStream}
		this._stream = new MediaStream();
	}

	async send({ track, simulcast }) // eslint-disable-line no-unused-vars
	{
		logger.debug('send() [kind:%s, track.id:%s]', track.kind, track.id);

		if (this._stream.getTrackById(track.id))
			throw new DuplicatedError('track already added');

		let rtpSender;

		try
		{
			// Add the track to the local stream.
			this._stream.addTrack(track);

			// Add the stream to the PeerConnection.
			rtpSender = this._pc.addTrack(track, this._stream);

			const offer = await this._pc.createOffer();

			logger.debug(
				'send() | calling pc.setLocalDescription() [offer:%o]', offer);

			await this._pc.setLocalDescription(offer);

			if (!this._transportReady)
				await this._setupTransport({ localDtlsRole: 'server' });

			const localSdpObj = sdpTransform.parse(this._pc.localDescription.sdp);
			const remoteSdp = this._remoteSdp.createAnswerSdp(localSdpObj);
			const answer = { type: 'answer', sdp: remoteSdp };

			logger.debug(
				'send() | calling pc.setRemoteDescription() [answer:%o]', answer);

			await this._pc.setRemoteDescription(answer);

			const rtpParameters =
				utils.clone(this._sendingRtpParametersByKind[track.kind]);

			// Fill the RTP parameters for this track.
			sdpPlanBUtils.fillRtpParametersForTrack(rtpParameters, localSdpObj, track);

			return rtpParameters;
		}
		catch (error)
		{
			// Panic here. Try to undo things.

			this._stream.removeTrack(track);
			try { this._pc.removeTrack(rtpSender); }
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

		// Remove the associated RtpSender.
		this._pc.removeTrack(rtpSender);

		// Remove the track from the local stream.
		this._stream.removeTrack(track);

		const offer = await this._pc.createOffer();

		logger.debug(
			'stopSending() | calling pc.setLocalDescription() [offer:%o]', offer);

		try
		{
			await this._pc.setLocalDescription(offer);
		}
		catch (error)
		{
			// NOTE: If there are no sending tracks, setLocalDescription() will fail with
			// "Failed to create channels". If so, ignore it.
			if (this._stream.getTracks().length === 0)
			{
				logger.warn(
					'stopSending() | ignoring expected error due no sending tracks: %s',
					error.toString());

				return;
			}

			throw error;
		}

		if (this._pc.signalingState === 'stable')
			return;

		const localSdpObj = sdpTransform.parse(this._pc.localDescription.sdp);
		const remoteSdp = this._remoteSdp.createAnswerSdp(localSdpObj);
		const answer = { type: 'answer', sdp: remoteSdp };

		logger.debug(
			'stopSending() | calling pc.setRemoteDescription() [answer:%o]', answer);

		await this._pc.setRemoteDescription(answer);
	}

	async replaceTrack({ track, newTrack })
	{
		logger.debug('replaceTrack() [newTrack.id:%s]', newTrack.id);

		if (this._stream.getTrackById(newTrack.id))
			throw new DuplicatedError('track already added');

		// Get the associated RTCRtpSender.
		const rtpSender = this._pc.getSenders()
			.find((s) => s.track === track);

		if (!rtpSender)
			throw new Error('local track not found');

		await rtpSender.replaceTrack(newTrack);

		// Remove the old track from the local stream.
		this._stream.removeTrack(track);

		// Add the new track to the local stream.
		this._stream.addTrack(newTrack);
	}

	async setMaxSpatialLayer({ track, spatialLayer })
	{
		logger.debug(
			'setMaxSpatialLayer() [track.id:%s, spatialLayer:%s]',
			track.id, spatialLayer);

		throw new UnsupportedError('not supported');
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
			'restartIce() | calling pc.setLocalDescription() [offer:%o]', offer);

		await this._pc.setLocalDescription(offer);

		const localSdpObj = sdpTransform.parse(this._pc.localDescription.sdp);
		const remoteSdp = this._remoteSdp.createAnswerSdp(localSdpObj);
		const answer = { type: 'answer', sdp: remoteSdp };

		logger.debug(
			'restartIce() | calling pc.setRemoteDescription() [answer:%o]', answer);

		await this._pc.setRemoteDescription(answer);
	}
}

class RecvHandler extends Handler
{
	constructor(data)
	{
		super(data);

		// Seen media kinds.
		// @type {Set<String>}
		this._kinds = new Set();

		// Map of receivers information indexed by id.
		// - kind {String}
		// - trackId {String}
		// - ssrc {Number}
		// - rtxSsrc {Number}
		// - cname {String}
		// @type {Map<String, Object>}
		this._receiverInfos = new Map();
	}

	async receive({ id, kind, rtpParameters })
	{
		logger.debug('receive() [id:%s, kind:%s]', id, kind);

		if (this._receiverInfos.has(id))
			throw new DuplicatedError('already receiving this source');

		const encoding = rtpParameters.encodings[0];
		const cname = rtpParameters.rtcp.cname;
		const receiverInfo =
		{
			kind     : kind,
			streamId : id,
			trackId  : `${kind}-${id}`,
			ssrc     : encoding.ssrc,
			cname    : cname
		};

		if (encoding.rtx && encoding.rtx.ssrc)
			receiverInfo.rtxSsrc = encoding.rtx.ssrc;

		this._receiverInfos.set(id, receiverInfo);
		this._kinds.add(kind);

		const remoteSdp = this._remoteSdp.createOfferSdp(
			Array.from(this._kinds), Array.from(this._receiverInfos.values()));
		const offer = { type: 'offer', sdp: remoteSdp };

		logger.debug(
			'receive() | calling pc.setRemoteDescription() [offer:%o]', offer);

		try
		{
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
			'receive() | calling pc.setLocalDescription() [answer:%o]', answer);

		await this._pc.setLocalDescription(answer);

		if (!this._transportUpdated)
			await this._setupTransport({ localDtlsRole: 'client' });

		const newRtpReceiver = this._pc.getReceivers()
			.find((rtpReceiver) =>
			{
				const { track } = rtpReceiver;

				if (!track)
					return false;

				return track.id === receiverInfo.trackId;
			});

		if (!newRtpReceiver)
			throw new Error('remote track not found');

		return newRtpReceiver.track;
	}

	async stopReceiving({ id })
	{
		logger.debug('stopReceiving() [id:%s]', id);

		if (!this._receiverInfos.has(id))
			throw new Error('source not found');

		this._receiverInfos.delete(id);

		const remoteSdp = this._remoteSdp.createOfferSdp(
			Array.from(this._kinds), Array.from(this._receiverInfos.values()));
		const offer = { type: 'offer', sdp: remoteSdp };

		logger.debug(
			'stopReceiving() | calling pc.setRemoteDescription() [offer:%o]', offer);

		await this._pc.setRemoteDescription(offer);

		const answer = this._pc.createAnswer();

		logger.debug(
			'stopReceiving() | calling pc.setLocalDescription() [answer:%o]', answer);

		await this._pc.setLocalDescription(answer);
	}

	async getReceiverStats({ id })
	{
		const receiverInfo = this._receiverInfos.get(id);

		if (!receiverInfo)
			throw new Error('receiver not found');

		const { trackId } = receiverInfo;

		// Get the associated RTCRtpReceiver.
		const rtpReceiver = this._pc.getReceivers()
			.find((r) => r.track && r.track.id === trackId);

		if (!rtpReceiver)
			throw new Error('RTCRtpReceiver not found');

		return rtpReceiver.getStats();
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
			Array.from(this._kinds), Array.from(this._receiverInfos.values()));
		const offer = { type: 'offer', sdp: remoteSdp };

		logger.debug(
			'restartIce() | calling pc.setRemoteDescription() [offer:%o]', offer);

		await this._pc.setRemoteDescription(offer);

		const answer = await this._pc.createAnswer();

		logger.debug(
			'restartIce() | calling pc.setLocalDescription() [answer:%o]', answer);

		await this._pc.setLocalDescription(answer);
	}
}

class Safari11
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

		try
		{
			pc.addTransceiver('audio');
			pc.addTransceiver('video');

			const offer = await pc.createOffer();

			try { pc.close(); }
			catch (error) {}

			const sdpObj = sdpTransform.parse(offer.sdp);
			const nativeRtpCapabilities =
				sdpCommonUtils.extractRtpCapabilities(sdpObj);

			return nativeRtpCapabilities;
		}
		catch (error)
		{
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
				const receivingRtpParametersByKind =
				{
					audio : ortc.getReceivingFullRtpParameters('audio', extendedRtpCapabilities),
					video : ortc.getReceivingFullRtpParameters('video', extendedRtpCapabilities)
				};

				return new RecvHandler(
					{
						transportRemoteParameters,
						iceServers,
						iceTransportPolicy,
						proprietaryConstraints,
						receivingRtpParametersByKind
					});
			}
		}
	}
}

module.exports = Safari11;
