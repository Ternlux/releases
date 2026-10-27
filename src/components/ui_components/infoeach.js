
import React from 'react';



export class Infoeach extends React.Component{
  constructor(props) {
    super(props);
    this.state = {
        showbox: false
    }
  } 
  showboxthere(){
      this.setState({showbox: true})
  }
  hideboxthere(){
      this.setState({showbox: false})
  }
  checkstatus(){
    for (var key in this.props.filters) {
        if (this.props.filters[key] !== null && this.props.filters[key] != "")
            return true;
    }
    return false
  }
    render() {
        var fil = []
        if(this.props.filters != null)
        fil = (this.checkstatus())? Object.keys(this.props.filters): ["none"];
        
    return(
        <div>
        {(this.props.showbox) && <div className="info-value-boxtotal">
            <div className="info-value-desc">Description:</div><div className="info-value-val">{this.props.description}</div>
            <div className="info-value-desc">Filters in Use:</div>
            <div className="info-value-val">{fil.map((e) => {
            if(e == "none") return <div key="none">None</div>
            if(this.props.filters[e]) return <div key={e}>{e}: {this.props.filters[e]}</div>})}
            </div>
        </div>}
        </div>
    )}
}