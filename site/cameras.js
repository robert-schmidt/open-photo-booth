// The cameras the booth controls over USB (the camera's live view on the screen, its own shutter for the photo), as the
// makers' SDKs list them: Sony's Camera Remote SDK 2.02, Nikon's Remote SDK 2.1 for Z. The last entry is everything
// libgphoto2 reaches (camera-helper/gphoto.cpp). The app's settings show this list.
const CAMERAS = [
  { maker: 'Sony', note: 'Set the camera\'s USB mode to Remote Shoot (PC Remote).', models: [
    'α1 II', 'α1', 'α9 III', 'α9 II', 'α7R VI', 'α7R V', 'α7R IVA', 'α7R IV', 'α7CR', 'α7S III', 'α7 V', 'α7 IV',
    'α7C II', 'α7C', 'α6700', 'ZV-E1', 'ZV-E10 II', 'FX2', 'FX3 (firmware 2.00 or later)', 'FX3A', 'FX30', 'RX1R III',
    'RX0 II (firmware 3.00 or later)', 'ILX-LR1'] },
  { maker: 'Nikon', note: 'Quit NX Tether and Camera Control Pro first.', models: [
    'Z9', 'Z8', 'Zf', 'Z7II', 'Z7', 'Z6III', 'Z6II', 'Z6', 'Z5II', 'Z5IIC', 'Z5', 'Z50II', 'Z50', 'Z30', 'Zfc', 'ZR'] },
  { maker: 'Canon EOS, Nikon DSLRs, older Sony', note: 'On a Mac, through the open-source libgphoto2: experimental, and not yet tried on real cameras. Quit the maker\'s own tethering app first. Otherwise use the camera\'s webcam mode or an HDMI capture card.', models: [] },
]
if (typeof module !== 'undefined') module.exports = CAMERAS
