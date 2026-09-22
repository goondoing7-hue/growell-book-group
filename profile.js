(function(root, factory){
  var api = factory();
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.GrowellProfile=api;
})(typeof window!=='undefined'?window:globalThis, function(){
  'use strict';
  function validateFile(file){
    if(!file || !/^image\/(jpeg|png|webp|gif)$/i.test(file.type||'')) return 'JPG, PNG, WEBP 또는 GIF 사진을 선택해주세요.';
    if(!Number.isFinite(file.size) || file.size<=0) return '비어 있는 사진 파일이에요. 다른 사진을 선택해주세요.';
    if(file.size>15*1024*1024) return '사진은 15MB 이하로 선택해주세요.';
    return '';
  }
  function safeAvatarUrl(value){
    if(typeof value!=='string' || value.length>1000000) return '';
    if(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return value;
    try{
      var url=new URL(value);
      return url.protocol==='https:' && !url.username && !url.password ? url.href : '';
    }catch(e){return '';}
  }
  function cropBounds(width,height){
    if(!Number.isFinite(width) || !Number.isFinite(height) || width<=0 || height<=0 || width*height>80000000) throw new Error('사진 크기를 확인할 수 없거나 너무 커요. 작은 사진으로 다시 시도해주세요.');
    var side=Math.min(width,height);
    return {x:(width-side)/2,y:(height-side)/2,side:side};
  }
  function resize(file, size, quality){
    var error=validateFile(file);
    if(error) return Promise.reject(new Error(error));
    size=Math.max(64,Math.min(512,Number(size)||256));
    quality=Number(quality)||0.86;
    return new Promise(function(resolve,reject){
      var source=URL.createObjectURL(file), img=new Image();
      function done(error,value){URL.revokeObjectURL(source); error?reject(error):resolve(value);}
      img.onload=function(){
        try{
          var bounds=cropBounds(img.naturalWidth,img.naturalHeight), canvas=document.createElement('canvas');
          canvas.width=size;canvas.height=size;
          var ctx=canvas.getContext('2d');
          if(!ctx) throw new Error('사진을 처리하지 못했어요. 다른 브라우저에서 다시 시도해주세요.');
          ctx.fillStyle='#ffffff';ctx.fillRect(0,0,size,size);
          ctx.drawImage(img,bounds.x,bounds.y,bounds.side,bounds.side,0,0,size,size);
          done(null,canvas.toDataURL('image/jpeg',quality));
        }catch(error){done(error);}
      };
      img.onerror=function(){done(new Error('사진을 읽지 못했어요. JPG 또는 PNG 사진으로 다시 시도해주세요.'));};
      img.src=source;
    });
  }
  return {validateFile:validateFile,safeAvatarUrl:safeAvatarUrl,cropBounds:cropBounds,resize:resize};
});
