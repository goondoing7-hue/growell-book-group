(function(root, factory){
  var api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.GrowellArchiveDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  var FORMAT = 'growell-book-archive-v1';
  // Reuse the existing encrypted private-record owner policies and recovery flow.
  // This is a storage scope only; archive books are identified by their reserved ID.
  var STORAGE_BOOK_ID = 'emotion';
  var PREFIX = 'private_archive_';
  var MAX_COVER_DATA_CHARS = 700 * 1024;
  var MAX_RECORD_CHARS = 8 * 1024 * 1024;
  var THEME_IDS = ['emotion','thought','body','action'];
  var NOTE_CATEGORIES = ['quote','thought','question','insight'];
  var NOTE_BACKGROUNDS = ['#EFE6D8','#E4EEE6','#F3E1E6','#E1EAF3','#E9E2F2','#F4EDE0'];

  function validOwner(value){
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
  }
  function validArchiveId(value){
    return typeof value === 'string' && /^arc_[A-Za-z0-9_-]{1,160}$/.test(value);
  }
  function recordId(userId, archiveId){
    if(!validOwner(userId) || !validArchiveId(archiveId)) throw new TypeError('회원과 아카이브 정보가 필요해요.');
    return PREFIX + userId + '_' + archiveId;
  }
  function archiveId(entry){
    if(!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      !validOwner(entry.userId) || entry.bookId !== STORAGE_BOOK_ID || typeof entry.id !== 'string') return null;
    var prefix = PREFIX + entry.userId + '_';
    if(entry.id.slice(0,prefix.length) !== prefix) return null;
    var id = entry.id.slice(prefix.length);
    return validArchiveId(id) ? id : null;
  }
  function isArchiveEntry(entry){ return archiveId(entry) !== null; }
  function text(value, limit, label){
    if(value == null) return '';
    if(typeof value !== 'string') throw new TypeError(label + ' 형식이 올바르지 않아요.');
    var result = value.trim();
    if(Array.from(result).length > limit) throw new RangeError(label + '은(는) ' + limit + '자까지 입력할 수 있어요.');
    return result;
  }
  function date(value, label){
    var result = text(value,10,label);
    if(!result) return '';
    if(!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new TypeError(label + '을(를) 올바르게 입력해주세요.');
    var parsed = new Date(result + 'T00:00:00Z');
    if(!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== result || result.slice(0,4) === '0000'){
      throw new TypeError(label + '을(를) 올바르게 입력해주세요.');
    }
    return result;
  }
  function url(value, label, image){
    if(image && typeof value === 'string' && value.indexOf('data:') === 0){
      if(value.length > MAX_COVER_DATA_CHARS || !/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(value)){
        throw new TypeError('표지는 작은 JPEG 사진으로 올려주세요.');
      }
      var bytes;
      try{ bytes = atob(value.slice('data:image/jpeg;base64,'.length)); }catch(e){ throw new TypeError('표지 사진을 확인해주세요.'); }
      if(bytes.length < 4 || bytes.charCodeAt(bytes.length-2) !== 255 || bytes.charCodeAt(bytes.length-1) !== 217){
        throw new TypeError('표지 사진을 확인해주세요.');
      }
      return value;
    }
    var result = text(value,4096,label);
    if(!result) return '';
    // Existing book artwork may be local; remote artwork must use HTTPS.
    if(image && /^\/?covers\/[A-Za-z0-9_/-]+\.(?:jpe?g|png|webp)$/i.test(result)) return result;
    var parsed;
    try{ parsed = new URL(result); }catch(e){ throw new TypeError(label + ' 주소가 올바르지 않아요.'); }
    if(parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password){
      throw new TypeError(label + '에는 https 주소를 입력해주세요.');
    }
    return parsed.href;
  }
  function safeCoverUrl(value){
    try{return url(value,'표지',true);}catch(e){return '';}
  }
  function authors(value){
    if(value == null || value === '') return [];
    var items = typeof value === 'string' ? value.split(',') : value;
    if(!Array.isArray(items) || items.length > 30) throw new TypeError('저자 정보를 확인해주세요.');
    var result = [];
    items.forEach(function(item){
      var name = text(item,200,'저자');
      if(name && result.indexOf(name) < 0) result.push(name);
    });
    return result;
  }
  function labels(value,limit,maxLength,label,allowed){
    if(value == null) return [];
    if(!Array.isArray(value)) throw new TypeError(label + ' 목록을 확인해주세요.');
    var result=[];
    Array.from(value).forEach(function(item){
      var name=text(item,maxLength,label);
      if(!name || allowed && allowed.indexOf(name)<0) throw new TypeError(label + ' 항목을 확인해주세요.');
      if(result.indexOf(name)<0) result.push(name);
      if(result.length>limit) throw new RangeError(label + '은(는) ' + limit + '개까지 선택할 수 있어요.');
    });
    return result;
  }
  function choice(value,allowed,label){
    var result=text(value,80,label);
    if(result && allowed.indexOf(result)<0) throw new TypeError(label + '을(를) 확인해주세요.');
    return result;
  }
  function integer(value,min,max,label){
    if(typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
    if(!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(label + '을(를) 확인해주세요.');
    return value;
  }
  function itemId(value){
    if(typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new TypeError('기록 식별자가 올바르지 않아요.');
    return value;
  }
  function timestamp(value,label){return integer(value,1,8640000000000000,label);}
  function prepareReadingSession(value){
    if(!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('독서 시간 기록이 올바르지 않아요.');
    var start = integer(value.startPage == null ? 0 : value.startPage,0,100000,'시작 쪽수');
    var end = integer(value.endPage == null ? start : value.endPage,0,100000,'마지막 쪽수');
    if(end < start) throw new RangeError('마지막 쪽수는 시작 쪽수보다 작을 수 없어요.');
    return {id:itemId(value.id),seconds:integer(value.seconds,0,31536000,'읽은 시간'),
      startPage:start,endPage:end,createdAt:timestamp(value.createdAt,'기록 시각')};
  }
  function prepareNote(value){
    if(!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('독서 노트가 올바르지 않아요.');
    var body = text(value.text,10000,'노트');
    if(!body) throw new TypeError('기록할 내용을 적어주세요.');
    var created = timestamp(value.createdAt,'기록 시각');
    var updated = value.updatedAt == null ? null : timestamp(value.updatedAt,'수정 시각');
    if(updated !== null && updated < created) throw new RangeError('수정 시각이 기록 시각보다 빠를 수 없어요.');
    if(value.deleted !== undefined && typeof value.deleted !== 'boolean') throw new TypeError('노트 상태가 올바르지 않아요.');
    return {id:itemId(value.id),text:body,title:text(value.title,300,'노트 제목'),html:text(value.html,100000,'노트 서식'),
      category:choice(value.category,NOTE_CATEGORIES,'노트 분류'),
      page:value.page == null || value.page === '' ? null : integer(value.page,0,100000,'노트 쪽수'),
      bgColor:choice(value.bgColor,NOTE_BACKGROUNDS,'노트 배경색'),photo:url(value.photo,'노트 사진',true),
      createdAt:created,updatedAt:updated,deleted:value.deleted === true};
  }
  function prepareItems(value,limit,prepareItem,label){
    if(value === undefined) return [];
    if(!Array.isArray(value) || value.length > limit) throw new RangeError(label + ' 목록을 확인해주세요.');
    var ids = new Set();
    return Array.from(value).map(function(item){
      var prepared = prepareItem(item);
      if(ids.has(prepared.id)) throw new TypeError(label + ' 식별자가 중복되어 있어요.');
      ids.add(prepared.id);return prepared;
    });
  }
  function prepare(value){
    if(!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('책 정보가 올바르지 않아요.');
    var title = text(value.title,300,'책 제목');
    if(!title) throw new TypeError('책 제목을 입력해주세요.');
    var startDate = date(value.startDate,'읽기 시작한 날짜');
    var endDate = date(value.endDate,'다 읽은 날짜');
    if(startDate && endDate && startDate > endDate) throw new RangeError('다 읽은 날짜는 시작한 날짜보다 빠를 수 없어요.');
    var rating = value.rating == null || value.rating === '' ? 0 : value.rating;
    if(typeof rating === 'string' && /^[0-5]$/.test(rating)) rating = Number(rating);
    if(!Number.isInteger(rating) || rating < 0 || rating > 5) throw new RangeError('별점은 1개부터 5개까지 선택해주세요.');
    var pageCount = value.pageCount == null || value.pageCount === '' ? null : value.pageCount;
    if(typeof pageCount === 'string' && /^\d+$/.test(pageCount)) pageCount = Number(pageCount);
    if(pageCount !== null && (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 100000)) throw new RangeError('전체 쪽수를 확인해주세요.');
    var status = value.status === undefined ? 'completed' : value.status;
    if(['unread','reading','completed'].indexOf(status) < 0) throw new TypeError('독서 상태를 선택해주세요.');
    var totalPages = value.totalPages === undefined ? pageCount : value.totalPages;
    if(totalPages === '' || totalPages === null) totalPages = null;
    else totalPages = integer(totalPages,1,100000,'전체 쪽수');
    var currentPage = integer(value.currentPage == null || value.currentPage === '' ? 0 : value.currentPage,0,100000,'읽은 쪽수');
    if(status === 'unread') currentPage = 0;
    if(status === 'completed' && totalPages !== null) currentPage = totalPages;
    if(totalPages !== null && currentPage > totalPages) throw new RangeError('읽은 쪽수는 전체 쪽수보다 클 수 없어요.');
    if(value.deleted !== undefined && typeof value.deleted !== 'boolean') throw new TypeError('아카이브 상태가 올바르지 않아요.');
    return {
      title:title,
      authors:authors(value.authors),
      publisher:text(value.publisher,300,'출판사'),
      publishedDate:text(value.publishedDate,40,'출간일'),
      isbn:text(value.isbn,80,'ISBN'),
      coverUrl:url(value.coverUrl,'표지',true),
      description:text(value.description,16000,'책 소개'),
      authorIntro:text(value.authorIntro,8000,'저자 소개'),
      tableOfContents:text(value.tableOfContents,20000,'목차'),
      sourceUrl:url(value.sourceUrl,'책 정보',false),
      source:text(value.source,80,'검색 출처'),
      providerId:text(value.providerId,300,'검색 식별자'),
      genres:labels(value.genres,8,80,'장르'),
      themes:labels(value.themes,4,80,'독서 주제',THEME_IDS),
      linkedBookId:choice(value.linkedBookId,THEME_IDS,'연결된 모임 책'),
      genreSource:choice(value.genreSource,['yes24','google','manual'],'장르 출처'),
      pageCount:pageCount,
      status:status,
      currentPage:currentPage,
      totalPages:totalPages,
      readingSessions:prepareItems(value.readingSessions,10000,prepareReadingSession,'독서 시간'),
      linkedSessionIds:labels(value.linkedSessionIds,10000,160,'연결된 독서 기록').map(itemId),
      notes:prepareItems(value.notes,500,prepareNote,'독서 노트'),
      startDate:startDate,
      endDate:endDate,
      rating:rating,
      review:text(value.review,10000,'평가 이유'),
      deleted:value.deleted === true
    };
  }
  function encode(book){
    var encoded = JSON.stringify({format:FORMAT,book:prepare(book)});
    if(encoded.length > MAX_RECORD_CHARS) throw new RangeError('한 책의 기록이 너무 커요. 표지나 노트의 크기를 줄여주세요.');
    return encoded;
  }
  function decode(value){
    if(typeof value !== 'string' || value.length > MAX_RECORD_CHARS) throw new TypeError('저장된 아카이브 형식이 올바르지 않아요.');
    var payload = JSON.parse(value);
    if(!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.format !== FORMAT){
      throw new TypeError('지원하지 않는 아카이브 형식이에요.');
    }
    return prepare(payload.book);
  }
  function progress(book){
    var item = prepare(book);
    return {currentPage:item.currentPage,totalPages:item.totalPages,
      percent:item.totalPages === null ? null : Math.round(item.currentPage/item.totalPages*100)};
  }
  function totalReadingSeconds(book){
    return prepare(book).readingSessions.reduce(function(total,session){return total + session.seconds;},0);
  }
  function addReadingSession(book,value,options){
    var item = prepare(book),session = prepareReadingSession(value);
    var existing = item.readingSessions.find(function(saved){return saved.id === session.id;});
    if(existing){
      if(JSON.stringify(existing) !== JSON.stringify(session)) throw new Error('같은 독서 기록이 다른 내용으로 저장되어 있어요.');
      return item;
    }
    if(item.totalPages !== null && session.endPage > item.totalPages) throw new RangeError('읽은 쪽수는 전체 쪽수보다 클 수 없어요.');
    var latestAt = item.readingSessions.reduce(function(latest,saved){return Math.max(latest,saved.createdAt);},0);
    item.readingSessions.push(session);
    // Late recovery of an older timer adds its elapsed time without replacing
    // the reading position of a later saved session. A newer re-read may go back.
    if(session.createdAt >= latestAt){
      item.currentPage = session.endPage;
      item.status = options && options.complete === true || item.totalPages !== null && item.currentPage === item.totalPages ? 'completed' : 'reading';
    }
    return prepare(item);
  }
  function upsertNote(book,value){
    var item = prepare(book),note = prepareNote(value);
    var index = item.notes.findIndex(function(saved){return saved.id === note.id;});
    if(index >= 0){
      var existing = item.notes[index];
      if(note.createdAt !== existing.createdAt) throw new Error('기록한 시각을 바꿀 수 없어요.');
      if((note.updatedAt || note.createdAt) < (existing.updatedAt || existing.createdAt)) throw new Error('이 노트가 다른 곳에서 수정됐어요.');
      item.notes[index] = note;
    } else item.notes.push(note);
    return prepare(item);
  }
  function removeNote(book,id,updatedAt){
    var item = prepare(book),note = item.notes.find(function(saved){return saved.id === itemId(id);});
    if(!note) throw new Error('기록을 찾을 수 없어요.');
    if(note.deleted) return item;
    return upsertNote(item,Object.assign({},note,{deleted:true,updatedAt:updatedAt}));
  }
  function summary(books){
    if(!Array.isArray(books)) throw new TypeError('책 목록 형식이 올바르지 않아요.');
    var count = 0, total = 0, ratedCount = 0;
    books.forEach(function(book){
      var item = prepare(book); if(item.deleted) return; ++count;
      if(item.rating){ total += item.rating; ++ratedCount; }
    });
    return {count:count,ratedCount:ratedCount,averageRating:ratedCount ? total/ratedCount : 0};
  }

  function normalizedName(value){return value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();}
  function normalizedIsbn(value){
    var result=value.replace(/[\s-]/g,'').toUpperCase();
    return /^(?:\d{13}|\d{9}[\dX])$/.test(result) ? result : '';
  }
  function sameTitleAuthors(left,right){
    if(normalizedName(left.title)!==normalizedName(right.title) || !left.authors.length || !right.authors.length) return false;
    var leftIsbn=normalizedIsbn(left.isbn),rightIsbn=normalizedIsbn(right.isbn);
    // A different ISBN denotes a different edition even when its title matches.
    if(leftIsbn && rightIsbn && leftIsbn!==rightIsbn) return false;
    return JSON.stringify(left.authors.map(normalizedName).sort())===JSON.stringify(right.authors.map(normalizedName).sort());
  }
  function mergedLinkedBook(book,progressFields){
    // Only replace sessions previously identified as shared snapshots. Older
    // independent archive sessions remain private history after a link is added.
    var previous=book.readingSessions.filter(function(session){return book.linkedSessionIds.indexOf(session.id)<0;});
    progressFields.readingSessions.forEach(function(session){
      var existing=previous.find(function(saved){return saved.id===session.id;});
      if(existing&&JSON.stringify(existing)!==JSON.stringify(session))throw new Error('같은 독서 기록이 다른 내용으로 저장되어 있어요.');
      if(!existing)previous.push(session);
    });
    return prepare(Object.assign({},book,progressFields,{readingSessions:previous}));
  }
  function mergeLinkedRows(rows,snapshots,ownerId){
    if(!validOwner(ownerId)) throw new TypeError('회원 정보가 필요해요.');
    if(!Array.isArray(rows) || !Array.isArray(snapshots)) throw new TypeError('책 목록 형식이 올바르지 않아요.');
    // Never decrypt, match, or return records from a different signed-in member.
    var result=rows.filter(function(row){return row && row.entry && row.entry.userId===ownerId;}).map(function(row){
      if(!isArchiveEntry(row.entry)) throw new TypeError('아카이브 기록 식별자를 확인해주세요.');
      return Object.assign({},row,{entry:Object.assign({},row.entry),book:prepare(row.book)});
    });
    var seen=new Set();
    snapshots.forEach(function(snapshot){
      if(!snapshot || snapshot.userId!==undefined && snapshot.userId!==ownerId) return;
      var bookId=choice(snapshot.bookId,THEME_IDS,'연결된 모임 책');
      if(!bookId) throw new TypeError('연결된 모임 책을 확인해주세요.');
      if(seen.has(bookId)) throw new TypeError('모임 책의 독서 정보가 중복되어 있어요.');
      seen.add(bookId);
      var catalog=prepare(snapshot.book),sessions=prepareItems(snapshot.readingSessions,10000,prepareReadingSession,'독서 시간');
      var total=snapshot.totalPages===undefined?catalog.totalPages:snapshot.totalPages;
      if(total!==null) total=integer(total,1,100000,'전체 쪽수');
      var current=integer(snapshot.currentPage==null?0:snapshot.currentPage,0,100000,'읽은 쪽수');
      if(total!==null && current>total) throw new RangeError('읽은 쪽수는 전체 쪽수보다 클 수 없어요.');
      if(snapshot.active!==undefined && typeof snapshot.active!=='boolean') throw new TypeError('독서 상태를 확인해주세요.');
      var started=snapshot.startedAt==null?null:timestamp(snapshot.startedAt,'읽기 시작한 시각');
      var updated=snapshot.updatedAt==null?null:timestamp(snapshot.updatedAt,'독서 갱신 시각');
      var active=current>0 || sessions.length>0 || snapshot.active===true;
      var index=result.findIndex(function(row){return row.book.linkedBookId===bookId;});
      if(index<0 && !active) return;
      if(index<0){
        var isbn=normalizedIsbn(catalog.isbn);
        if(isbn) index=result.findIndex(function(row){return !row.book.linkedBookId && !row.book.readingSessions.length && normalizedIsbn(row.book.isbn)===isbn;});
      }
      if(index<0) index=result.findIndex(function(row){return !row.book.linkedBookId && !row.book.readingSessions.length && sameTitleAuthors(row.book,catalog);});
      var status=total!==null && current===total?'completed':active?'reading':'unread';
      var progressFields={linkedBookId:bookId,currentPage:current,totalPages:total,status:status,readingSessions:sessions,linkedSessionIds:sessions.map(function(session){return session.id;})};
      if(index>=0){
        // Keep personal writing, ratings, classification (including an explicit empty
        // selection), deletion, and any independent archived reading history.
        result[index]=Object.assign({},result[index],{book:mergedLinkedBook(result[index].book,progressFields)});
      } else {
        var entry={id:recordId(ownerId,'arc_shared_'+bookId),userId:ownerId,bookId:STORAGE_BOOK_ID,createdAt:started||updated||1};
        if(updated!==null) entry.updatedAt=updated;
        // A previously materialized automatic card keeps its identity after edits.
        index=result.findIndex(function(row){return row.entry.id===entry.id;});
        if(index>=0){
          result[index]=Object.assign({},result[index],{book:mergedLinkedBook(result[index].book,progressFields)});
        } else result.push({entry:entry,virtual:true,book:prepare(Object.assign({},catalog,progressFields,
          {themes:[bookId],notes:[],review:'',rating:0,deleted:false}))});
      }
    });
    return result;
  }

  return {FORMAT:FORMAT,STORAGE_BOOK_ID:STORAGE_BOOK_ID,recordId:recordId,archiveId:archiveId,
    isArchiveEntry:isArchiveEntry,safeCoverUrl:safeCoverUrl,prepare:prepare,encode:encode,decode:decode,summary:summary,
    progress:progress,totalReadingSeconds:totalReadingSeconds,addReadingSession:addReadingSession,
    upsertNote:upsertNote,removeNote:removeNote,mergeLinkedRows:mergeLinkedRows};
});
