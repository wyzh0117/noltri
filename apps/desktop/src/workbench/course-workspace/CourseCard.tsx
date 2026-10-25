import type {ReactElement} from 'react';
import {Icon} from './ui/Icon';
import type {CourseSummary} from './workspace-navigation';
export function CourseCard({course,path,onOpen}:{course:CourseSummary;path?:string;onOpen:()=>void}):ReactElement {return <button type="button" className="cw-course-card" onClick={onOpen}><span className="cw-course-mark"><Icon name="book"/></span><span className="cw-card-kind">课程</span><strong>{course.title}</strong><p>{course.summary||'打开课程，继续阅读与整理。'}</p><span className="cw-card-path" title={path??course.paths[0].map(n=>n.title).join(' / ')}>{path??course.paths[0].map(n=>n.title).join(' / ')}</span><span className="cw-card-meta"><span>{course.itemCount} 条内容</span><span>打开课程 <Icon name="forward"/></span></span></button>;}
