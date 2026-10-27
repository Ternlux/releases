
import React from 'react';
import {Loader_sidebar} from './loader_sidebar'
import {Infoeach} from './infoeach';


export class Boxdataset extends React.Component{
  constructor(props) {
    super(props);
    this.state = {
      showbox: false
    }

  } 
  numberWithCommas(x, currency, round) {
    if(!x) return 'No Data'
    if(round){
      x = Math.round(x / 1000)
      x += 'K'
    }
    x = x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    if(currency) return currency + ' ' + x
    
    return x;
  }
  hideboxthere = () => {
    this.setState({showbox: false})
  }

  showboxthere = () => {
    this.setState({showbox: true})
  }
  boxClickFunction = () => {
    if(this.props.boxClickFunction){
      this.props.boxClickFunction({key: this.props.mid_text, value: this.props.total_current})
    }
  }

render() {
  if(this.props.type)
      {
        // console.log(this.props.mid_text, this.props.total_current)
      
      var total_current = (this.props.stringval)? this.props.total_current: this.numberWithCommas(this.props.total_current, this.props.currency, this.props.round);
      if(this.props.total_past){
      var total_past = (this.props.stringval)? this.props.total_past: this.numberWithCommas(this.props.total_past, this.props.currency, this.props.round);
      var percent_diff = (this.props.total_diff * 100).toFixed(1);
      var color_percentdiff= null
      //color changer for the population based on demographic
      var typevalue = null;
      var margin =null;

      if(percent_diff >= 5){
       color_percentdiff = this.props.negativeGood ? "rgba(242, 38, 19, 1)" : "rgba(30, 130, 76, 1)"; 
       typevalue = "up";
       margin = "-22px"
      }
      else if(percent_diff < 5 && percent_diff >= 0){
       color_percentdiff= "rgba(247, 202, 24, 1)";
       typevalue = "up"
       margin = "-22px"
      }
      else{
       color_percentdiff= this.props.negativeGood ? "rgba(30, 130, 76, 1)" : "rgba(242, 38, 19, 1)" ; 
       typevalue = "down"
       margin = "-13px"
      }
      }
      }

      
    return (<div className={this.props.classnameval}  onClick={this.boxClickFunction} >


      {!this.props.exportInd && <Infoeach showbox={this.state.showbox} makevalue={true} margin={this.props.margin} description={this.props.description} filters={this.props.filters}/>}
    {(this.props.type)?  
    <div>
      <div className='display-flex-space-between m-10'>
        <div className="box-industry-type">{this.props.mid_text}</div>
        {!this.props.exportInd && <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" onMouseEnter={this.showboxthere} onMouseLeave={this.hideboxthere}>
            <path d="M7.99967 10.6668V8.00016M7.99967 5.3335H8.00634M14.6663 8.00016C14.6663 11.6821 11.6816 14.6668 7.99967 14.6668C4.31778 14.6668 1.33301 11.6821 1.33301 8.00016C1.33301 4.31826 4.31778 1.3335 7.99967 1.3335C11.6816 1.3335 14.6663 4.31826 14.6663 8.00016Z" stroke="#717680" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>}
      </div>
    <div className="box-pop-current" >{total_current}</div>
    
    {(total_past)? 
    <div>
      
    <div className="box-price-bottom box-price">
      
      <div className="box-price-bottom-diff box-price-total" style={{color:color_percentdiff}}>
      <div className="box-price-up">
      <div><div className={"fa fa-angle-"+typevalue} style={{"marginTop": margin, position: 'absolute'}}></div></div><div className="box-price-line">|</div></div>
        <div className='ml-5 display-inline-block'>
        {percent_diff}%
        </div>
      </div>
    </div>
    <div className="box-industry-type-prev box-industry-type">Prev. Period: <div className="box-price-bottom box-pop-current box-price-total color-black">{total_past}</div></div>
    </div>
    : null}
    </div>
    : <Loader_sidebar/> }
    </div>);
      }
}