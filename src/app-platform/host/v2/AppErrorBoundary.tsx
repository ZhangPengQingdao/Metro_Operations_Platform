import React from 'react';
import {Button} from '../../../components/ui/Button';

export class AppErrorBoundary extends React.Component<{children:React.ReactNode;onRetry():void},{failed:boolean}>{
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 componentDidCatch(error:unknown){console.error('应用页面出错',error);}
 render(){
  if(!this.state.failed)return this.props.children;
  return <div className="app-v2-error" role="alert"><p>应用页面出错。</p><Button variant="secondary" onClick={()=>{this.setState({failed:false});this.props.onRetry();}}>重新加载</Button></div>;
 }
}
