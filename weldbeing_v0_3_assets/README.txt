# Weldbeing v0.3 Assets

## Edge Bridge (EB)
- Purpose: EB connects to camera AP (rtsp://192.168.254.1/live) and restreams as RTSP on LAN via mediamtx.
- Files:
  - weld-eb.service — systemd unit to auto-run EB docker-compose.
  - docker-compose.eb.yml — mediamtx in host mode.
  - mediamtx.yml — pull-on-demand path 'cam' from camera.
  - Dockerfile.eb-helper — optional tools.

Install on EB:
  sudo mkdir -p /opt/weld-eb && cd /opt/weld-eb
  sudo cp docker-compose.eb.yml mediamtx.yml /opt/weld-eb/
  sudo cp weld-eb.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now weld-eb.service
Test URL:
  rtsp://<EB_LAN_IP>:8554/cam

## SRT Listener (Recorder side)
- docker-compose.srt-listener.yml launches SRS with SRT at 10085/udp and a recorder that pulls streams listed in scripts/srt_streams.txt.
- Publishers push to: srt://<RECORDER_HOST>:10085?streamid=publish/live/<name>
- Recorder pulls from: srt://sls:10085?streamid=live/<name> and remuxes to MP4.
