(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./archiveDomain.js'),require('./readingFormatDomain.js'));
  else root.GrowellSharedReadingFormat=factory(root.GrowellArchiveDomain,root.GrowellReadingFormatDomain);
})(typeof globalThis!=='undefined'?globalThis:this,function(Archive,Format){
  'use strict';
  function create(adapter){
    var cache=new Map(),pending=new Map(),generation=0;
    function context(id){
      var session=adapter.session(),catalog=adapter.catalog(id);
      if(!session||adapter.status()!=='ready'||!catalog||!adapter.allowed(id))throw new Error('로그인과 독서 기록을 먼저 확인해주세요.');
      return {session:session,epoch:adapter.epoch(),id:id,catalog:catalog,generation:generation};
    }
    function guard(c){if(c.generation!==generation||adapter.session()!==c.session||adapter.epoch()!==c.epoch||adapter.status()!=='ready'||!adapter.allowed(c.id))throw new Error('로그인과 책의 연결 상태가 바뀌었어요. 다시 열어주세요.');}
    function idFor(c){return Archive.recordId(c.session.userId,'arc_shared_'+c.id);}
    function source(c){var expected=idFor(c),entry=adapter.entry(expected);if(entry&&(entry.id!==expected||entry.userId!==c.session.userId||!Archive.isArchiveEntry(entry)))throw new Error('내 책의 기록만 열 수 있어요.');return entry||null;}
    function signature(entry){return entry?JSON.stringify([entry.id,entry.bookId,entry.userId,entry.iv,entry.data]):'new';}
    function base(c){return Archive.prepare(c.catalog);}
    function announce(){if(adapter.changed)adapter.changed();}
    async function read(c){
      guard(c);var entry=source(c),stamp=signature(entry);
      if(!entry)return {entry:null,book:base(c)};
      var row=await adapter.read(entry);guard(c);
      if(signature(source(c))!==stamp)throw new Error('다른 곳에서 바뀐 독서 기록을 다시 불러와 주세요.');
      if(!row||!row.entry||signature(row.entry)!==stamp)throw new Error('독서 기록을 확인하지 못했어요.');
      return {entry:Object.assign({},entry),book:Archive.prepare(row.book)};
    }
    function remember(c,row){guard(c);if(!row||!row.entry||signature(source(c))!==signature(row.entry))throw new Error('저장된 독서 기록을 다시 확인해주세요.');cache.set(c.id,{session:c.session,epoch:c.epoch,stamp:signature(row.entry),book:Archive.prepare(row.book)});return row;}
    function view(id){
      var c;try{c=context(id);}catch(e){return {status:'loading',book:null,settings:null,sessions:[]};}
      var entry,stamp,old;try{entry=source(c);stamp=signature(entry);old=cache.get(id);if(!entry)return {status:'ready',book:base(c),settings:Format.normalizeSettings(null),sessions:[]};}catch(e){return {status:'error',book:null,settings:null,sessions:[]};}
      if(old&&old.session===c.session&&old.epoch===c.epoch&&old.stamp===stamp){
        if(old.error)return {status:'error',book:null,settings:null,sessions:[]};
        var visible=Archive.prepare(old.book);return {status:'ready',book:visible,settings:Format.normalizeSettings(visible.readingSettings),sessions:visible.readingSessions.filter(function(s){return s.unit==='percent';})};
      }
      var waiting=pending.get(id);
      if(!waiting||waiting.session!==c.session||waiting.epoch!==c.epoch||waiting.generation!==c.generation||waiting.stamp!==stamp){
        var record={session:c.session,epoch:c.epoch,generation:c.generation,stamp:stamp,promise:null};
        record.promise=read(c).then(function(row){remember(c,row);}).catch(function(){try{guard(c);if(signature(source(c))===stamp)cache.set(id,{session:c.session,epoch:c.epoch,stamp:stamp,error:true});}catch(e){}}).finally(function(){if(pending.get(id)===record){pending.delete(id);announce();}});
        pending.set(id,record);
      }
      return {status:'loading',book:null,settings:null,sessions:[]};
    }
    async function store(c,row,book){
      guard(c);if(signature(source(c))!==signature(row.entry))throw new Error('다른 곳에서 바뀐 독서 기록을 다시 불러와 주세요.');if(row.book.deleted)throw new Error('책장의 휴지통에서 이 책을 복원한 뒤 기록해주세요.');
      var saved=await adapter.save(row.entry?row:null,Archive.prepare(book),'arc_shared_'+c.id);guard(c);
      remember(c,saved);announce();return saved;
    }
    async function ensure(id){var c=context(id),row=await read(c);if(row.entry){if(row.book.deleted)throw new Error('책장의 휴지통에서 이 책을 복원해주세요.');return remember(c,row);}return store(c,row,row.book);}
    async function settings(id,next){
      if(!next||typeof next!=='object'||Array.isArray(next)||['paper','ebook'].indexOf(next.format)<0)throw new Error('읽는 방식을 확인해주세요.');
      var c=context(id),row=await read(c),current=row.book.readingSettings,choice=Format.normalizeSettings(Object.assign({},next,{ebook:next.ebook===undefined?current.ebook:next.ebook}));
      if(JSON.stringify(choice.ebook)!==JSON.stringify(current.ebook)&&choice.ebook.updatedAt<=current.ebook.updatedAt){
        if(choice.format!==current.format)choice.ebook=Format.normalizeSettings(current).ebook;
        else throw new Error('다른 화면에서 읽는 위치가 바뀌었어요. 닫고 다시 열어주세요.');
      }
      var book=Archive.setReadingSettings(row.book,choice);
      return (await store(c,row,book)).book.readingSettings;
    }
    async function session(id,item,options){
      var c=context(id),row=await read(c),book=Archive.addReadingSession(row.book,item,options);
      if(item.unit!=='percent')throw new Error('전자책의 독서 위치를 확인해주세요.');
      if(!book.startDate)book.startDate=new Date(item.createdAt+9*3600000).toISOString().slice(0,10);
      if(options&&options.complete===true&&!book.endDate)book.endDate=new Date(item.createdAt+9*3600000).toISOString().slice(0,10);
      return store(c,row,book);
    }
    return {view:view,ensure:ensure,saveSettings:settings,saveSession:session,reset:function(){generation++;cache.clear();pending.clear();}};
  }
  return {create:create};
});
