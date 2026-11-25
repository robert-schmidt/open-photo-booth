// The cameras the booth controls over USB (the camera's live view on the screen, its own shutter for the photo), as the
// makers' SDKs list them: Sony's Camera Remote SDK 2.02, Nikon's Remote SDK 2.1 for Z. The app's settings show this list.
const CAMERAS = [
  { maker: 'Sony', note: 'Set the camera\'s USB mode to Remote Shoot (PC Remote).', models: [
    'α1 II', 'α1', 'α9 III', 'α9 II', 'α7R VI', 'α7R V', 'α7R IVA', 'α7R IV', 'α7CR', 'α7S III', 'α7 V', 'α7 IV',
    'α7C II', 'α7C', 'α6700', 'ZV-E1', 'ZV-E10 II', 'FX2', 'FX3 (firmware 2.00 or later)', 'FX3A', 'FX30', 'RX1R III',
    'RX0 II (firmware 3.00 or later)', 'ILX-LR1'] },
  { maker: 'Nikon', note: 'Quit NX Tether and Camera Control Pro first.', models: [
    'Z9', 'Z8', 'Zf', 'Z7II', 'Z7', 'Z6III', 'Z6II', 'Z6', 'Z5II', 'Z5IIC', 'Z5', 'Z50II', 'Z50', 'Z30', 'Zfc', 'ZR'] },
  { maker: 'Canon', note: 'Not controlled yet. Use Canon\'s EOS Webcam Utility or an HDMI capture card meanwhile.', models: [] },
]
if (typeof module !== 'undefined') module.exports = CAMERAS
