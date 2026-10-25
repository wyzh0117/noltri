import {expect,it} from 'vitest';
import {bytesToBase64} from './ResourceDialog';
it('encodes binary attachment chunks without corrupting UTF-8 or high bytes',()=>{const bytes=new Uint8Array([0,1,127,128,254,255]);expect(bytesToBase64(bytes)).toBe('AAF/gP7/');expect(bytesToBase64(new TextEncoder().encode('中文😀'))).toBe(Buffer.from('中文😀').toString('base64'));});
