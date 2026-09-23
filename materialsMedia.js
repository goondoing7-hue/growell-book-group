(function(root,factory){
  var api=factory(root);
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.GrowellMaterialsMedia=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  var document=root.document;
  var scriptUrl=document && document.currentScript && document.currentScript.src;
  var baseUrl=scriptUrl || (document && document.baseURI);
  var pdfLibraryPromise=null;
  var MAX_PDF_BYTES=25*1024*1024;

  function safeResourceUrl(value){
    if(typeof value!=='string') return null;
    var url=value.trim();
    if(!/^https?:\/\//i.test(url) || /[\u0000-\u0020<>"'`\\]/.test(url)) return null;
    try {
      var parsed=new URL(url);
      return parsed.hostname && !parsed.username && !parsed.password &&
        (parsed.protocol==='https:' || parsed.protocol==='http:') ? url : null;
    } catch(error){ return null; }
  }
  function safeImageUrl(value){
    if(typeof value==='string' && /^data:image\/(?:jpeg|png|webp|gif);base64,[a-z0-9+/]+={0,2}$/i.test(value)) return value;
    return safeResourceUrl(value);
  }
  function youtubeId(value){
    var safe=safeResourceUrl(value);
    if(!safe) return null;
    var url=new URL(safe), host=url.hostname.toLowerCase(), id=null;
    if(host==='youtu.be' || host==='www.youtu.be') id=url.pathname.split('/')[1];
    else if(['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com','youtube-nocookie.com','www.youtube-nocookie.com'].indexOf(host)!==-1){
      if(url.pathname==='/watch') id=url.searchParams.get('v');
      else if(/^\/(?:shorts|embed|live)\//.test(url.pathname)) id=url.pathname.split('/')[2];
    }
    return typeof id==='string' && /^[A-Za-z0-9_-]{11}$/.test(id)?id:null;
  }
  function normalizeAttachment(value){
    if(!value || typeof value!=='object') return null;
    var href=safeResourceUrl(value.driveUrl);
    if(!href) return null;
    var result={title:typeof value.title==='string'?value.title.trim():'',driveUrl:href};
    var thumbnailUrl=safeImageUrl(value.thumbnailUrl);
    if(thumbnailUrl) result.thumbnailUrl=thumbnailUrl;
    if(typeof value.mimeType==='string' && value.mimeType.length<=150) result.mimeType=value.mimeType.trim();
    if(typeof value.fileName==='string' && value.fileName.length<=500) result.fileName=value.fileName.trim();
    if(typeof value.fileSize==='number' && Number.isSafeInteger(value.fileSize) && value.fileSize>=0) result.fileSize=value.fileSize;
    if(typeof value.size==='number' && Number.isSafeInteger(value.size) && value.size>=0) result.size=value.size;
    return result;
  }
  function normalizeAttachments(value){
    if(typeof value==='string'){try{value=JSON.parse(value);}catch(error){return [];}}
    return Array.isArray(value)?value.map(normalizeAttachment).filter(Boolean):[];
  }
  function thumbnail(note,bodyUrls){
    note=note || {};
    var links=normalizeAttachments(note.driveLinks), i, id;
    for(i=0;i<links.length;i++){
      if(links[i].thumbnailUrl) return {src:links[i].thumbnailUrl,href:links[i].driveUrl,kind:youtubeId(links[i].driveUrl)?'video':'file'};
    }
    var photo=safeImageUrl(note.photo && note.photo.dataUrl);
    if(photo) return {src:photo,href:links.length?links[0].driveUrl:safeResourceUrl(photo),
      kind:links.length?(youtubeId(links[0].driveUrl)?'video':'file'):'image'};
    var urls=links.map(function(link){return link.driveUrl;}).concat(Array.isArray(bodyUrls)?bodyUrls:[]);
    for(i=0;i<urls.length;i++){
      id=youtubeId(urls[i]);
      if(id) return {src:'https://i.ytimg.com/vi/'+id+'/hqdefault.jpg',href:safeResourceUrl(urls[i]),kind:'video'};
    }
    return null;
  }
  function isPdf(file){
    return !!file && (String(file.type || '').toLowerCase()==='application/pdf' || /\.pdf$/i.test(file.name || ''));
  }
  function assetUrl(path){
    if(!baseUrl) throw new Error('PDF 미리보기를 불러올 수 없어요.');
    return new URL('vendor/pdfjs/'+path,baseUrl).href;
  }
  function loadPdfLibrary(){
    if(!pdfLibraryPromise){
      pdfLibraryPromise=import(assetUrl('pdf.min.mjs')).then(function(pdfjs){
        pdfjs.GlobalWorkerOptions.workerSrc=assetUrl('pdf.worker.min.mjs');
        return pdfjs;
      }).catch(function(error){pdfLibraryPromise=null;throw error;});
    }
    return pdfLibraryPromise;
  }
  async function renderPdfThumbnail(file,options){
    options=options || {};
    if(file && typeof file.size==='number' && file.size>MAX_PDF_BYTES) throw new Error('PDF 파일은 25MB 이하로 선택해주세요.');
    var source=file && typeof file.arrayBuffer==='function'?await file.arrayBuffer():file;
    var bytes=source instanceof ArrayBuffer?new Uint8Array(source.slice(0)):
      ArrayBuffer.isView(source)?new Uint8Array(source.buffer.slice(source.byteOffset,source.byteOffset+source.byteLength)):null;
    if(!bytes || !bytes.byteLength) throw new Error('PDF 파일을 읽을 수 없어요.');
    if(bytes.byteLength>MAX_PDF_BYTES) throw new Error('PDF 파일은 25MB 이하로 선택해주세요.');
    var header='';
    for(var i=0;i<Math.min(1024,bytes.length);i++) header+=String.fromCharCode(bytes[i]);
    if(header.indexOf('%PDF-')===-1) throw new Error('올바른 PDF 파일을 선택해주세요.');
    var pdfjs=options.pdfjs || await loadPdfLibrary();
    var loadingTask=null, pdf=null, canvas=null, timeout;
    var timeoutMs=options.timeoutMs || 30000;
    var work=(async function(){
      var config={data:bytes,isEvalSupported:false,enableXfa:false,stopAtErrors:true,maxImageSize:16777216,
        useSystemFonts:true,disableAutoFetch:true};
      if(!options.pdfjs){
        config.cMapUrl=assetUrl('cmaps/');config.cMapPacked=true;
        config.standardFontDataUrl=assetUrl('standard_fonts/');
        config.wasmUrl=assetUrl('wasm/');config.iccUrl=assetUrl('iccs/');
      }
      loadingTask=pdfjs.getDocument(config);
      pdf=await loadingTask.promise;
      var page=await pdf.getPage(1);
      var first=page.getViewport({scale:1});
      if(!(first.width>0 && first.height>0)) throw new Error('PDF 첫 페이지를 읽을 수 없어요.');
      var maxDimension=Math.min(640,Math.max(120,Number(options.maxDimension)||320));
      var scale=Math.min(1,maxDimension/Math.max(first.width,first.height));
      var viewport=page.getViewport({scale:scale});
      canvas=options.createCanvas?options.createCanvas():document.createElement('canvas');
      canvas.width=Math.max(1,Math.ceil(viewport.width));canvas.height=Math.max(1,Math.ceil(viewport.height));
      var context=canvas.getContext('2d');
      if(!context) throw new Error('이 브라우저에서 PDF 미리보기를 만들 수 없어요.');
      await page.render({canvasContext:context,viewport:viewport,background:'#ffffff',annotationMode:0}).promise;
      var dataUrl=canvas.toDataURL('image/jpeg',0.86);
      if(!safeImageUrl(dataUrl)) throw new Error('PDF 미리보기를 만들지 못했어요.');
      return dataUrl;
    })();
    try {
      return await Promise.race([work,new Promise(function(resolve,reject){timeout=setTimeout(function(){reject(new Error('PDF 미리보기 생성 시간이 초과되었어요. 대표 사진을 직접 선택해주세요.'));},timeoutMs);})]);
    } finally {
      clearTimeout(timeout);
      if(loadingTask && typeof loadingTask.destroy==='function'){
        try{await loadingTask.destroy();}catch(error){}
      } else if(pdf && typeof pdf.destroy==='function'){
        try{await pdf.destroy();}catch(error){}
      }
      if(canvas){canvas.width=0;canvas.height=0;}
    }
  }
  return {safeResourceUrl:safeResourceUrl,safeImageUrl:safeImageUrl,youtubeId:youtubeId,
    normalizeAttachment:normalizeAttachment,normalizeAttachments:normalizeAttachments,thumbnail:thumbnail,
    isPdf:isPdf,renderPdfThumbnail:renderPdfThumbnail,MAX_PDF_BYTES:MAX_PDF_BYTES};
});
