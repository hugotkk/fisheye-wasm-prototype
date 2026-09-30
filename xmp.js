// Port of insp2pano.py's gpano_xmp()/encode_jpeg(): splice a GPano XMP APP1
// segment right after SOI so the JPEG is recognized as a 360 photo.
function gpanoXmpSegment(w, h) {
  const xml =
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf=' +
    '"http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description ' +
    'rdf:about="" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" ' +
    'GPano:ProjectionType="equirectangular" GPano:UsePanoramaViewer="True" ' +
    `GPano:FullPanoWidthPixels="${w}" GPano:FullPanoHeightPixels="${h}" ` +
    `GPano:CroppedAreaImageWidthPixels="${w}" GPano:CroppedAreaImageHeightPixels="${h}" ` +
    'GPano:CroppedAreaLeftPixels="0" GPano:CroppedAreaTopPixels="0"/>' +
    '</rdf:RDF></x:xmpmeta>';
  const header = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\x00');
  const xmlBytes = new TextEncoder().encode(xml);
  const payload = new Uint8Array(header.length + xmlBytes.length);
  payload.set(header, 0);
  payload.set(xmlBytes, header.length);
  const len = payload.length + 2;
  const seg = new Uint8Array(4 + payload.length);
  seg[0] = 0xff; seg[1] = 0xe1;
  seg[2] = (len >> 8) & 0xff; seg[3] = len & 0xff;
  seg.set(payload, 4);
  return seg;
}

async function embedGpanoXmp(jpegBlob, w, h) {
  const buf = new Uint8Array(await jpegBlob.arrayBuffer());
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG (missing SOI)');
  const seg = gpanoXmpSegment(w, h);
  const out = new Uint8Array(2 + seg.length + (buf.length - 2));
  out.set(buf.subarray(0, 2), 0);
  out.set(seg, 2);
  out.set(buf.subarray(2), 2 + seg.length);
  return new Blob([out], { type: 'image/jpeg' });
}
